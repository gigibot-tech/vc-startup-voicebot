"""ElevenLabs TTS adapter with tonality (voice settings)."""

from __future__ import annotations

import os
from typing import Any

from elevenlabs import ElevenLabs
from elevenlabs.types.voice_settings import VoiceSettings

from startup_voice.language import normalize_language

# George — premade voice (works on free API). Library voices need a paid plan.
_DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"
_DEFAULT_MODEL = "eleven_flash_v2_5"


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def synthesize_mp3(
    text: str,
    *,
    language: str | None = None,
    stability: float | None = None,
    similarity: float | None = None,
    style: float | None = None,
    speed: float | None = None,
) -> bytes:
    """Return MP3 bytes for intake replies in the session language (env default: German)."""
    api_key = os.getenv("ELEVENLABS_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ELEVENLABS_API_KEY missing")
    client = ElevenLabs(api_key=api_key)
    stab = _clamp(
        float(stability if stability is not None else os.getenv("ELEVENLABS_STABILITY", "0.45")),
        0.0,
        1.0,
    )
    sim = _clamp(
        float(similarity if similarity is not None else os.getenv("ELEVENLABS_SIMILARITY", "0.75")),
        0.0,
        1.0,
    )
    sty = _clamp(
        float(style if style is not None else os.getenv("ELEVENLABS_STYLE", "0.0")),
        0.0,
        1.0,
    )
    # ElevenLabs voice speed typically ~0.7–1.2
    spd = _clamp(
        float(speed if speed is not None else os.getenv("ELEVENLABS_SPEED", "1.0")),
        0.7,
        1.2,
    )
    settings = VoiceSettings(
        stability=stab,
        similarity_boost=sim,
        style=sty,
        speed=spd,
        use_speaker_boost=True,
    )
    stream = client.text_to_speech.convert(
        text=text.strip(),
        voice_id=os.getenv("ELEVENLABS_VOICE_ID", _DEFAULT_VOICE),
        model_id=os.getenv("ELEVENLABS_TTS_MODEL", _DEFAULT_MODEL),
        language_code=normalize_language(language) if language else os.getenv("ELEVENLABS_LANGUAGE", "de"),
        output_format="mp3_44100_128",
        voice_settings=settings,
    )
    return b"".join(chunk for chunk in stream if chunk)


def default_voice_settings() -> dict[str, Any]:
    return {
        "stability": float(os.getenv("ELEVENLABS_STABILITY", "0.45")),
        "similarity": float(os.getenv("ELEVENLABS_SIMILARITY", "0.75")),
        "style": float(os.getenv("ELEVENLABS_STYLE", "0.0")),
        "speed": float(os.getenv("ELEVENLABS_SPEED", "1.0")),
    }
