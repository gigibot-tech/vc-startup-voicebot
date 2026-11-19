"""LiveKit voice worker: ears and mouth only. It NEVER calls the LLM.

Run it next to the web app (separate process):

    uv run --extra livekit-voice startup-voice-agent dev      # auto-reload, local
    uv run --extra livekit-voice startup-voice-agent start    # production

What it does per call (one LiveKit room per call, the browser joined with a token from
POST /api/voice/join):

    founder mic --WebRTC--> VAD + STT (turn detection) --"transcript"--> browser
                                                                           │ chat.sendText()
    founder speaker <--WebRTC-- TTS <--text pieces (speak_*)-- browser <───┘ POST /turn/stream

The browser stays the orchestrator, so bubbles, the review gate and the dossier behave exactly
as in classic mode. Interruptions (founder talks over the agent) are handled here: playout is
cut and the browser is told (``speak_done interrupted``). Protocol: livekit_protocol.py.

Env: LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET (read by the livekit CLI),
DEEPGRAM_API_KEY or ELEVENLABS_API_KEY (STT; LIVEKIT_STT=deepgram|elevenlabs|local forces one;
local = LIVEKIT_STT_BASE_URL / LIVEKIT_STT_MODEL of an OpenAI-compatible Whisper server),
ELEVENLABS_API_KEY (TTS), optional LIVEKIT_TURN_DETECTOR=multilingual,
LIVEKIT_ENDPOINT_MIN / LIVEKIT_ENDPOINT_MAX (seconds of silence before the turn ends).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from dotenv import load_dotenv
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    StopResponse,
    cli,
    llm,
)
from livekit.agents.voice import room_io
from livekit.plugins import deepgram, elevenlabs, openai, silero

from startup_voice.features.voice.livekit_protocol import (
    TOPIC_CMD,
    TOPIC_EVT,
    SpeakCoordinator,
    decode,
    encode,
)

load_dotenv()
log = logging.getLogger("startup-voice.worker")

# Same defaults as features/voice/tts.py so both modes sound alike.
_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"
_DEFAULT_TTS_MODEL = "eleven_flash_v2_5"


def _clamp(v: Any, lo: float, hi: float, default: float) -> float:
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


def pick_stt_provider() -> str:
    """``LIVEKIT_STT`` wins (deepgram | elevenlabs | local); else Deepgram if its key exists, else ElevenLabs.

    ``local`` = any OpenAI-compatible Whisper server on your machine (LIVEKIT_STT_BASE_URL), so the
    founder's voice never leaves it. Not streaming: a turn is transcribed after you stop talking.
    """
    forced = os.getenv("LIVEKIT_STT", "").strip().lower()
    if forced == "openai_compatible":
        forced = "local"
    if forced in {"deepgram", "elevenlabs", "local"}:
        return forced
    if os.getenv("DEEPGRAM_API_KEY", "").strip():
        return "deepgram"
    if os.getenv("ELEVENLABS_API_KEY", "").strip():
        return "elevenlabs"
    raise RuntimeError("LiveKit voice needs DEEPGRAM_API_KEY or ELEVENLABS_API_KEY for speech-to-text")


def build_stt(language: str):
    provider = pick_stt_provider()
    if provider == "local":
        base_url = os.getenv("LIVEKIT_STT_BASE_URL", "").strip()
        if not base_url:
            raise RuntimeError("LIVEKIT_STT=local needs LIVEKIT_STT_BASE_URL (e.g. http://127.0.0.1:8000/v1)")
        return provider, openai.STT(
            model=os.getenv("LIVEKIT_STT_MODEL", "whisper-1"),
            base_url=base_url,
            api_key=os.getenv("LIVEKIT_STT_API_KEY", "local"),  # most local servers ignore it
            language=language,
        )
    if provider == "deepgram":
        return provider, deepgram.STT(
            model="nova-3",
            language=language,
            interim_results=True,
            smart_format=True,
            punctuate=True,
            api_key=os.environ["DEEPGRAM_API_KEY"].strip(),
        )
    return provider, elevenlabs.STT(
        api_key=os.environ["ELEVENLABS_API_KEY"].strip(),
        language_code=language,
        model="scribe_v2_realtime",
    )


def build_tts(language: str, voice: dict[str, Any]):
    key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not key:
        raise RuntimeError("LiveKit voice needs ELEVENLABS_API_KEY for text-to-speech")
    return elevenlabs.TTS(
        api_key=key,
        voice_id=os.getenv("ELEVENLABS_VOICE_ID", _DEFAULT_VOICE),
        model=os.getenv("ELEVENLABS_TTS_MODEL", _DEFAULT_TTS_MODEL),
        language=language,
        voice_settings=elevenlabs.VoiceSettings(
            stability=_clamp(voice.get("stability"), 0, 1, 0.45),
            similarity_boost=_clamp(voice.get("similarity"), 0, 1, 0.75),
            speed=_clamp(voice.get("speed"), 0.7, 1.2, 1.0),
            use_speaker_boost=True,
        ),
    )


def pick_turn_detection():
    """VAD by default; the semantic multilingual model only when asked for (extra download)."""
    if os.getenv("LIVEKIT_TURN_DETECTOR", "").strip().lower() == "multilingual":
        try:
            from livekit.plugins.turn_detector.multilingual import MultilingualModel

            return MultilingualModel()
        except Exception as exc:  # plugin missing / model files not downloaded
            log.warning("multilingual turn detector unavailable (%s) - using VAD", exc)
    return "vad"


def describe_voice_error(scope: str, detail: str, language: str = "de") -> str:
    """One founder-readable sentence for a failed STT/TTS provider (the raw error is for the log).

    ``scope``: "stt" | "tts". Quota / billing / key problems are the ones people can actually fix.
    """
    de = language.startswith("de")
    low = detail.lower()
    what = ("die Spracherkennung" if de else "speech recognition") if scope == "stt" else (
        "die Stimme" if de else "the voice")
    if "quota" in low or "exceeded" in low or "credit" in low or "payment" in low:
        return (f"Das Kontingent des Sprachanbieters ist aufgebraucht – {what} geht gerade nicht."
                if de else f"The speech provider's quota is used up - {what} is unavailable right now.")
    if "401" in low or "unauthorized" in low or "invalid api key" in low or "api key" in low:
        return (f"API-Schlüssel des Sprachanbieters abgelehnt – {what} geht nicht."
                if de else f"The speech provider rejected the API key - {what} is unavailable.")
    return (f"Der Sprachanbieter antwortet nicht - {what} geht gerade nicht."
            if de else f"The speech provider is not responding - {what} is unavailable.")


class VoiceIOAgent(Agent):
    """No LLM: when the founder's turn ends, hand the transcript to the browser and stop there."""

    def __init__(self, emit) -> None:
        super().__init__(instructions="Voice I/O only. The browser owns the conversation.")
        self._emit = emit

    async def on_user_turn_completed(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage) -> None:
        text = (new_message.text_content or "").strip()
        if text:
            self._emit({"t": "transcript", "text": text})
        raise StopResponse()  # no reply from here: the browser answers via /turn/stream + speak_*


def _parse_metadata(raw: str) -> dict[str, Any]:
    try:
        data = json.loads(raw or "{}")
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


server = AgentServer()


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session()
async def entrypoint(ctx: JobContext) -> None:
    await ctx.connect()
    participant = await ctx.wait_for_participant()
    meta = _parse_metadata(participant.metadata)
    language = str(meta.get("language") or "de")[:2].lower()
    voice_cfg = meta.get("voice") if isinstance(meta.get("voice"), dict) else {}
    # "browser": the founder's browser transcribes (local Whisper) and sends text; we only speak.
    browser_stt = meta.get("stt") == "browser"

    pending: set[asyncio.Task] = set()

    def emit(msg: dict[str, Any]) -> None:
        task = asyncio.ensure_future(
            ctx.room.local_participant.publish_data(encode(msg), reliable=True, topic=TOPIC_EVT)
        )
        pending.add(task)
        task.add_done_callback(pending.discard)

    try:
        stt_name, stt = ("browser", None) if browser_stt else build_stt(language)
        tts = build_tts(language, voice_cfg)
    except Exception as exc:
        log.error("voice worker setup failed: %s", exc)
        emit({"t": "error", "message": str(exc)})
        return

    session = AgentSession(
        stt=stt,  # None in browser mode
        tts=tts,
        vad=ctx.proc.userdata["vad"],
        turn_detection=pick_turn_detection(),
        # Founders pause to think mid-answer: wait longer than the 0.5 s default before cutting in.
        min_endpointing_delay=_clamp(os.getenv("LIVEKIT_ENDPOINT_MIN"), 0.2, 5.0, 0.9),
        max_endpointing_delay=_clamp(os.getenv("LIVEKIT_ENDPOINT_MAX"), 1.0, 10.0, 4.0),
        allow_interruptions=True,
    )
    coordinator = SpeakCoordinator(
        say=lambda text: session.say(text, allow_interruptions=True, add_to_chat_ctx=False),
        emit=emit,
    )

    @session.on("user_input_transcribed")
    def _on_words(ev) -> None:
        if not ev.is_final and ev.transcript.strip():
            emit({"t": "interim", "text": ev.transcript})

    reported: set[str] = set()

    @session.on("error")
    def _on_error(ev) -> None:
        """A provider gave up (quota, key, outage). Tell the browser: it used to hang on 'thinking'."""
        err = ev.error
        scope = {"stt_error": "stt", "tts_error": "tts"}.get(getattr(err, "type", ""), "")
        if not scope or getattr(err, "recoverable", True) or scope in reported:
            return
        reported.add(scope)
        detail = str(getattr(err, "error", err))
        log.error("voice worker %s failed for good: %s", scope, detail)
        emit({"t": "error", "scope": scope, "message": describe_voice_error(scope, detail, language)})

    @session.on("user_state_changed")
    def _on_user_state(ev) -> None:
        emit({"t": "user_state", "state": ev.new_state})

    @session.on("agent_state_changed")
    def _on_agent_state(ev) -> None:
        emit({"t": "agent_state", "state": ev.new_state})

    def _on_data(packet: rtc.DataPacket) -> None:
        if packet.topic != TOPIC_CMD:
            return
        cmd = decode(packet.data)
        if cmd is None:
            return
        if cmd.get("t") == "config":
            lang = str(cmd.get("language") or "")[:2].lower()
            if lang in {"de", "en"}:
                for part in (stt, tts):
                    if part is None:
                        continue
                    try:
                        part.update_options(language=lang)  # best effort: not every plugin has it
                    except Exception:
                        pass
            return
        coordinator.handle(cmd)

    ctx.room.on("data_received", _on_data)

    await session.start(
        agent=VoiceIOAgent(emit),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            participant_identity=participant.identity,
            audio_input=not browser_stt,  # browser mode: the mic never goes to the server
            text_output=False,  # transcripts reach the browser as "transcript" events instead
            close_on_disconnect=True,
        ),
    )
    emit({"t": "ready", "stt": stt_name, "tts": "elevenlabs", "language": language})


def main() -> None:
    cli.run_app(server)


if __name__ == "__main__":
    main()
