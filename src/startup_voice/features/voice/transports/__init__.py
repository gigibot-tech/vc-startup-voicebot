"""Voice modes, one interface. Add a mode = add a class here and register it in ``TRANSPORTS``.

``classic``  browser push-to-talk (always available, the fallback)
``livekit``  hands-free WebRTC with a server-side voice worker (needs LIVEKIT_* in .env)

``VOICE_MODE`` in .env picks the default for new browsers; the user can switch in Settings.
"""

from __future__ import annotations

import os

from startup_voice.features.voice.transports.base import TransportUnavailable, VoiceTransport
from startup_voice.features.voice.transports.classic import ClassicTransport
from startup_voice.features.voice.transports.livekit import LiveKitTransport

DEFAULT_MODE = "classic"


def _registry() -> dict[str, VoiceTransport]:
    return {t.name: t for t in (ClassicTransport(), LiveKitTransport())}


def get_transport(name: str) -> VoiceTransport:
    transports = _registry()
    try:
        return transports[(name or DEFAULT_MODE).strip().lower()]
    except KeyError:
        raise TransportUnavailable(f"unknown voice mode: {name!r}") from None


def describe_all() -> list[dict]:
    return [t.describe() for t in _registry().values()]


def available_modes() -> list[str]:
    return [t.name for t in _registry().values() if t.available()]


def default_mode() -> str:
    """``VOICE_MODE`` if it is usable, else ``classic`` (a bad .env never breaks the page)."""
    want = os.getenv("VOICE_MODE", DEFAULT_MODE).strip().lower()
    return want if want in available_modes() else DEFAULT_MODE


__all__ = [
    "TransportUnavailable",
    "VoiceTransport",
    "available_modes",
    "default_mode",
    "describe_all",
    "get_transport",
]
