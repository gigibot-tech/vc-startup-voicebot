"""LiveKit mode: hands-free conversation over WebRTC with a server-side voice worker.

Server side this module only *mints a join token* (HS256 JWT, stdlib only — the web app does
not need the livekit packages). The worker that listens and speaks is a separate process:
``features/voice/livekit_worker.py`` (``uv run --extra livekit-voice startup-voice-agent dev``).

Setup (.env):  LIVEKIT_URL=wss://<project>.livekit.cloud  (or ws://127.0.0.1:7880 for
``livekit-server --dev``), LIVEKIT_API_KEY, LIVEKIT_API_SECRET.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

from startup_voice.features.voice.transports.base import TransportUnavailable

_ENV = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
_TOKEN_TTL_S = 60 * 60


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def mint_token(
    *,
    api_key: str,
    api_secret: str,
    identity: str,
    room: str,
    name: str = "",
    metadata: str = "",
    ttl_s: int = _TOKEN_TTL_S,
    now: float | None = None,
) -> str:
    """LiveKit access token: a JWT signed with the API secret, carrying a video grant."""
    issued = int(now if now is not None else time.time())
    claims: dict[str, Any] = {
        "iss": api_key,
        "sub": identity,
        "nbf": issued,
        "exp": issued + int(ttl_s),
        "video": {
            "room": room,
            "roomJoin": True,
            "canPublish": True,
            "canSubscribe": True,
            "canPublishData": True,
        },
    }
    if name:
        claims["name"] = name
    if metadata:
        claims["metadata"] = metadata
    header = {"alg": "HS256", "typ": "JWT"}
    signing_input = ".".join(
        _b64url(json.dumps(part, separators=(",", ":")).encode("utf-8")) for part in (header, claims)
    )
    sig = hmac.new(api_secret.encode("utf-8"), signing_input.encode("ascii"), hashlib.sha256).digest()
    return f"{signing_input}.{_b64url(sig)}"


def _missing() -> list[str]:
    return [k for k in _ENV if not os.getenv(k, "").strip()]


class LiveKitTransport:
    name = "livekit"
    label = "LiveKit (hands-free)"

    def available(self) -> bool:
        return not _missing()

    def describe(self) -> dict[str, Any]:
        missing = _missing()
        return {
            "name": self.name,
            "label": self.label,
            "available": not missing,
            "reason": f"missing {', '.join(missing)} in .env" if missing else "",
        }

    def join(
        self, *, session_id: str, language: str, voice: dict[str, Any] | None = None,
        stt: str = "server",
    ) -> dict[str, Any]:
        missing = _missing()
        if missing:
            raise TransportUnavailable(f"LiveKit is not configured: missing {', '.join(missing)}")
        # One room per call: a stale room from an earlier call can never swallow this one,
        # and the worker is dispatched fresh. The session id travels in participant metadata.
        room = f"intake-{session_id}-{secrets.token_hex(3)}"
        identity = f"founder-{secrets.token_hex(4)}"
        metadata = json.dumps(
            {
                "session_id": session_id,
                "language": (language or "de")[:2].lower(),
                "voice": voice or {},
                "stt": "browser" if stt == "browser" else "server",
            },
            separators=(",", ":"),
        )
        token = mint_token(
            api_key=os.environ["LIVEKIT_API_KEY"].strip(),
            api_secret=os.environ["LIVEKIT_API_SECRET"].strip(),
            identity=identity,
            room=room,
            name="Founder",
            metadata=metadata,
        )
        return {
            "mode": self.name,
            "url": os.environ["LIVEKIT_URL"].strip(),
            "token": token,
            "room": room,
            "identity": identity,
            "ttl_s": _TOKEN_TTL_S,
        }
