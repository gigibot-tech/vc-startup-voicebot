"""Voice feature - HTTP routes: speech-to-text, text-to-speech, health checks, PersonaPlex config.

NONE OF THESE ROUTES CALL THE LLM. They turn speech into text and text into speech, nothing else.
What happens with a transcript is decided by the browser (see interview/routes.py).

BUTTON -> BACKEND FLOWS  (browser code: features/voice/ui/voice.js)
====================================================================

[Sprechen]  (#micBtn, next to the text box)  - three steps, the first two before recording
    1. voice.js voicePreflight()  -> POST /api/voice/preflight {stt, check_tts:false}
         -> voice_preflight() below: quick DNS/key probe of the chosen cloud STT.
         <- {mic: {ok, use}}  where use = "elevenlabs" | "deepgram" | "browser".
         If the cloud is unreachable the UI silently falls back to browser Web Speech.
    2a. use == "browser": the browser's own Web Speech API listens. NO request to this server.
    2b. use == cloud:     MediaRecorder records audio, then voice.js transcribeCloud()
         -> POST /api/stt (multipart: audio, language, provider, fallback)
         -> stt() below -> SttRouter.transcribe(): tries the provider, optionally the others.
         <- {text, provider, errors}
    3. The transcript goes to the interview feature via onTranscript -> sendText (not here).

[Stoppen / Abbrechen / Stopp Stimme]  (same mic button, label depends on phase)
    Browser only: stops recording / cancels the pending turn / stops audio. No request.

(automatic, after each agent reply)  voice.js speak(reply), if "Antworten vorlesen" is on
    -> POST /api/tts {text, language, stability, similarity, speed}
    -> tts() below -> probe_tts_fast() then synthesize_mp3() (ElevenLabs) -> audio/mpeg bytes.
    The browser plays the MP3. With "Weiterhören" on, the mic re-opens when playback ends.

[Einstellungen > STT / Tempo / Stabilität / Ähnlichkeit]
    Stored in localStorage only (prefs.js); sent along with the next /api/tts or /api/stt call.

(page load)  app.js boot -> GET /health
    -> health() below: which STT providers have keys; the UI picks a default from it.

(no button)  GET /api/sessions/{id}/personaplex-config: headers and tool schema for an external
    PersonaPlex/LiveKit voice agent, whose callbacks land on interview/routes.py tool_webhook().
"""

from __future__ import annotations

import os

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from startup_voice.features.sessions.registry import SessionRegistry
from startup_voice.features.voice import (
    SttError,
    available_providers,
    build_personaplex_functions_config,
    build_personaplex_headers,
    default_provider,
    default_voice_settings,
    elevenlabs_configured,
    get_router,
    personaplex_system_prompt,
    probe_tts_fast,
    synthesize_mp3,
)


class TtsBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    language: str | None = None
    stability: float | None = Field(default=None, ge=0, le=1)
    similarity: float | None = Field(default=None, ge=0, le=1)
    style: float | None = Field(default=None, ge=0, le=1)
    speed: float | None = Field(default=None, ge=0.7, le=1.5)


class VoicePreflightBody(BaseModel):
    stt: str = "auto"
    check_tts: bool = True


def build_router(*, registry: SessionRegistry) -> APIRouter:
    router = APIRouter(tags=["voice"])
    stt_router = get_router()

    @router.get("/health")
    def health() -> dict:
        """Liveness + which speech providers are configured (read once at page load).

        ``data_dir`` is included so a restart that points at a different session folder
        is obvious (Gespräche are files on disk — restart does not delete them).
        """
        return {
            "ok": True,
            "sessions": len(registry.store.list_ids()),
            "data_dir": str(registry.store.root.resolve()),
            "tts": "elevenlabs" if elevenlabs_configured() else "missing_key",
            "stt": default_provider(),
            "stt_providers": available_providers(),
            "voice_settings": default_voice_settings(),
        }

    @router.post("/api/voice/preflight")
    def voice_preflight(body: VoicePreflightBody) -> dict:
        """[Sprechen] step 1 - fail-fast DNS/key probes before mic recording or TTS spend."""
        want = (body.stt or "auto").strip().lower()
        if want in {"", "auto"}:
            want = default_provider()
        stt = stt_router.probe(want if want != "auto" else None)
        tts = probe_tts_fast() if body.check_tts else {"ok": True, "provider": None, "errors": [], "skipped": True}
        # Mic path is OK if STT cloud works OR browser fallback exists.
        mic_ok = bool(stt.get("ok")) or stt.get("fallback") == "browser"
        return {
            "ok": mic_ok,
            "stt": stt,
            "tts": tts,
            "mic": {
                "ok": mic_ok,
                "use": stt.get("provider") or stt.get("fallback") or "browser",
            },
        }

    @router.post("/api/tts")
    def tts(body: TtsBody) -> Response:
        """TEXT -> MP3. No LLM, no session. Reads aloud a reply that already exists."""
        # Fail fast before calling ElevenLabs synthesize.
        probe = probe_tts_fast()
        if not probe.get("ok"):
            raise HTTPException(503, f"TTS unavailable: {'; '.join(probe.get('errors') or ['unknown'])}")
        try:
            audio = synthesize_mp3(
                body.text,
                language=body.language,
                stability=body.stability,
                similarity=body.similarity,
                style=body.style,
                speed=body.speed,
            )
        except Exception as exc:
            detail = getattr(exc, "body", None) or str(exc)
            if isinstance(detail, dict):
                detail = (detail.get("detail") or detail)
                if isinstance(detail, dict):
                    detail = detail.get("message") or detail.get("code") or detail
            raise HTTPException(502, f"TTS failed: {detail}") from exc
        return Response(content=audio, media_type="audio/mpeg")

    @router.post("/api/stt")
    async def stt(
        audio: UploadFile = File(...),
        language: str = Form("de"),
        provider: str = Form(""),
        fallback: str = Form("1"),
    ) -> dict:
        """[Sprechen] step 2b - AUDIO -> TEXT. Returns a plain string; the browser decides what next."""
        raw = await audio.read()
        if not raw:
            raise HTTPException(400, "empty audio")
        ctype = audio.content_type or "application/octet-stream"
        want = (provider or default_provider()).strip().lower()
        if want == "browser":
            raise HTTPException(400, "browser STT is client-side — use Web Speech")
        if want == "auto":
            want = default_provider()
        do_fallback = fallback.strip().lower() not in {"0", "false", "no"}
        try:
            text, used, errors = stt_router.transcribe(
                raw,
                content_type=ctype,
                language=language,
                provider=want,
                fallback=do_fallback,
            )
        except SttError as exc:
            raise HTTPException(
                502,
                {
                    "message": f"STT failed: {exc}",
                    "fallback": "browser",
                    "errors": str(exc).split("; "),
                },
            ) from exc
        return {"text": text, "provider": used, "errors": errors}

    @router.get("/api/sessions/{session_id}/personaplex-config")
    def personaplex_config(session_id: str) -> dict:
        base = os.getenv("PUBLIC_BASE_URL", "http://127.0.0.1:8140")
        cfg = build_personaplex_functions_config(webhook_base=base, session_id=session_id)
        headers = build_personaplex_headers(
            text_prompt=personaplex_system_prompt(), functions_config=cfg
        )
        return {"functions": cfg, "headers": headers, "system_prompt": personaplex_system_prompt()}

    return router
