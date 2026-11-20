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

[Sprechen] when Settings > Voice mode = "LiveKit"  (browser: features/voice/ui/voice-livekit.js)
    POST /api/voice/join {mode, session_id, language, voice} -> voice_join() below
      <- {url, token, room}. The browser joins the LiveKit room; the voice worker
         (livekit_worker.py, separate process) listens, detects turns and speaks.
    Transcripts come back over the room's data channel and enter the SAME sendText() path as
    typing. Reply text goes the other way for the worker's TTS. No LLM call in this file.
    GET /health -> voice_modes lists the modes Settings may offer; GET /api/voice/transports
    says why a mode is unavailable.

(no button)  GET /api/sessions/{id}/personaplex-config: headers and tool schema for an external
    PersonaPlex/LiveKit voice agent, whose callbacks land on interview/routes.py tool_webhook().
"""

from __future__ import annotations

import os

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from startup_voice.features.sessions.registry import SessionRegistry
from startup_voice.features.voice.transports import (
    TransportUnavailable,
    available_modes,
    default_mode,
    describe_all,
    get_transport,
)
from startup_voice.features.voice import (
    SttError,
    available_providers,
    build_personaplex_functions_config,
    build_personaplex_headers,
    default_provider,
    refresh_elevenlabs_credits,
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


class VoiceJoinBody(BaseModel):
    mode: str = "livekit"
    session_id: str = Field(min_length=1)
    language: str = "de"
    #: tonality from Settings (stability / similarity / speed), handed to the voice worker
    voice: dict | None = None
    #: "server" = the worker listens; "browser" = the browser transcribes (local Whisper), worker only speaks
    stt: str = "server"


def _llm_region() -> str:
    """Where the server's reply model runs: ``LOCAL`` (this machine), an ISO country code, or "" (unknown).

    Scaleway is French. Ollama is local. An OpenAI-compatible host is local when its URL points at this
    machine; otherwise the operator states the country with ``LLM_REGION`` (e.g. ``DE`` for IONOS).
    """
    provider = (os.getenv("LLM_PROVIDER") or "ollama").strip().lower()
    if provider == "scaleway":
        return "FR"
    if provider == "ollama":
        return "LOCAL"
    host = (os.getenv("LLM_BASE_URL") or "").split("//")[-1].split("/")[0].split(":")[0].lower()
    if host in {"localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"}:
        return "LOCAL"
    return (os.getenv("LLM_REGION") or "").strip().upper()


def build_router(*, registry: SessionRegistry) -> APIRouter:
    router = APIRouter(tags=["voice"])
    stt_router = get_router()

    @router.get("/health")
    def health() -> dict:
        """Liveness + which speech providers are configured (read once at page load).

        ``data_dir`` is included so a restart that points at a different session folder
        is obvious (Gespräche are files on disk — restart does not delete them).
        """
        refresh_elevenlabs_credits()  # an out-of-credits ElevenLabs is not offered at all
        return {
            "ok": True,
            "sessions": len(registry.store.list_ids()),
            "data_dir": str(registry.store.root.resolve()),
            "tts": "elevenlabs" if elevenlabs_configured() else "missing_key",
            # which reply model the server runs (Settings hides Ollama on a deployed URL)
            "llm_provider": (os.getenv("LLM_PROVIDER") or "ollama").strip().lower(),
            "llm_model": (os.getenv("LLM_MODEL") or "").strip(),
            # where the reply model runs, for the header privacy chips: "LOCAL", an ISO country code, or ""
            "llm_region": _llm_region(),
            "stt": default_provider(),
            "stt_providers": available_providers(),
            "voice_settings": default_voice_settings(),
            # voice modes the Settings dropdown may offer (classic is always there)
            "voice_modes": available_modes(),
            "voice_mode": default_mode(),
        }

    @router.get("/api/voice/transports")
    def voice_transports() -> dict:
        """Every voice mode with ``available`` + a ``reason`` when it is not (for Settings)."""
        return {"default": default_mode(), "transports": describe_all()}

    @router.post("/api/voice/join")
    def voice_join(body: VoiceJoinBody) -> dict:
        """[Sprechen] in a non-classic mode - client config to start the call for one session.

        livekit: returns ``{url, token, room}``; the browser joins the room and the separate
        voice worker is dispatched into it. Still NO LLM here: transcripts come back to the
        browser, which sends them through the normal turn route.
        """
        registry.get(body.session_id)  # 404 for an unknown session
        try:
            transport = get_transport(body.mode)
            return transport.join(
                session_id=body.session_id, language=body.language, voice=body.voice, stt=body.stt
            )
        except TransportUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc

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
            err_s = str(detail)
            if "quota" in err_s.lower() or "0 credits" in err_s.lower() or "401" in str(exc):
                from startup_voice.features.voice.stt import mark_elevenlabs_unavailable
                mark_elevenlabs_unavailable("quota_exceeded")
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
        want = (provider or "auto").strip().lower()
        if want == "browser":
            raise HTTPException(400, "browser STT is client-side — use Web Speech")
        if want == "auto":
            want = stt_router.server_default()
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
