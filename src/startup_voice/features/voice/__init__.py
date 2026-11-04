"""Voice I/O feature — STT, TTS, PersonaPlex bridge (+ UI voice controls)."""

from startup_voice.features.voice.bridge import (
    build_personaplex_functions_config,
    build_personaplex_headers,
    parse_tool_webhook_body,
    personaplex_system_prompt,
)
from startup_voice.features.voice.stt import (
    SttError,
    available_providers,
    default_provider,
    deepgram_configured,
    elevenlabs_configured,
    get_router,
    probe_tts_fast,
    transcribe_audio,
)
from startup_voice.features.voice.tts import default_voice_settings, synthesize_mp3

__all__ = [
    "SttError",
    "available_providers",
    "build_personaplex_functions_config",
    "build_personaplex_headers",
    "default_provider",
    "default_voice_settings",
    "deepgram_configured",
    "elevenlabs_configured",
    "get_router",
    "parse_tool_webhook_body",
    "personaplex_system_prompt",
    "probe_tts_fast",
    "synthesize_mp3",
    "transcribe_audio",
]
