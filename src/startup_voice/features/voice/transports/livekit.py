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
import logging
import hmac
import json
import os
import secrets
import time
from pathlib import Path
from typing import Any

from startup_voice.features.voice.transports.base import TransportUnavailable

log = logging.getLogger("startup-voice.livekit")
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


def _http_base(url: str) -> str:
    """wss://x.livekit.cloud -> https://x.livekit.cloud (the server API speaks HTTP)."""
    url = url.strip().rstrip("/")
    for ws, http in (("wss://", "https://"), ("ws://", "http://")):
        if url.startswith(ws):
            return http + url[len(ws):]
    return url


_CHECK_TTL_S = 300.0
_check_cache: dict[str, Any] = {"at": 0.0, "result": None}


def check_credentials(*, force: bool = False, timeout: float = 4.0) -> dict[str, Any]:
    """Ask LiveKit itself whether URL + key + secret work (a signed, read-only ``ListRooms``).

    Returns ``{configured, valid, problem, hint}`` and never the secret. ``valid`` is True / False when
    LiveKit answered, None when it could not be reached (offline: not a credentials problem).
    A wrong key or secret is logged as an error, so it shows up in the server / function log.
    """
    import httpx  # imported here: the web app itself needs no LiveKit packages

    now = time.monotonic()
    if not force and _check_cache["result"] is not None and now - _check_cache["at"] < _CHECK_TTL_S:
        return _check_cache["result"]

    def done(result: dict[str, Any]) -> dict[str, Any]:
        _check_cache.update(at=now, result=result)
        if result["valid"] is False:
            log.error("LiveKit credentials problem: %s - %s", result["problem"], result["hint"])
        return result

    missing = _missing()
    if missing:
        return done({"configured": False, "valid": False, "problem": "missing",
                     "hint": f"Set {', '.join(missing)}."})
    url = os.environ["LIVEKIT_URL"].strip()
    key = os.environ["LIVEKIT_API_KEY"].strip()
    secret = os.environ["LIVEKIT_API_SECRET"].strip()
    if not url.startswith(("wss://", "ws://")):
        return done({"configured": True, "valid": False, "problem": "url",
                     "hint": "LIVEKIT_URL must start with wss:// (e.g. wss://<project>.livekit.cloud)."})
    issued = int(time.time())
    claims = {"iss": key, "sub": "credential-check", "nbf": issued, "exp": issued + 60, "video": {"roomList": True}}
    header = {"alg": "HS256", "typ": "JWT"}
    signing = ".".join(_b64url(json.dumps(p, separators=(",", ":")).encode()) for p in (header, claims))
    token = f"{signing}.{_b64url(hmac.new(secret.encode(), signing.encode('ascii'), hashlib.sha256).digest())}"
    try:
        res = httpx.post(
            f"{_http_base(url)}/twirp/livekit.RoomService/ListRooms",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            content=b"{}", timeout=timeout,
        )
    except httpx.HTTPError as exc:
        return done({"configured": True, "valid": None, "problem": "unreachable",
                     "hint": f"Could not reach {_http_base(url)}: {exc.__class__.__name__}."})
    if res.status_code == 200:
        return done({"configured": True, "valid": True, "problem": "", "hint": ""})
    if res.status_code in (401, 403):
        return done({"configured": True, "valid": False, "problem": "rejected",
                     "hint": "LiveKit rejected LIVEKIT_API_KEY / LIVEKIT_API_SECRET (wrong pair, a stray space or "
                             "quote, or they belong to another project than LIVEKIT_URL)."})
    return done({"configured": True, "valid": None, "problem": f"http {res.status_code}",
                 "hint": f"LiveKit answered HTTP {res.status_code}; check LIVEKIT_URL."})


_HEARTBEAT_MAX_AGE_S = 45.0


def heartbeat_path() -> Path:
    """File the voice worker touches every few seconds while it is registered with LiveKit."""
    return Path(os.getenv("LIVEKIT_HEARTBEAT_FILE") or "data/livekit-worker.alive")


def worker_state() -> str:
    """Is a voice worker there to answer a call? "external" | "alive" | "missing".

    The worker is a separate process; without it a joined call just waits. ``LIVEKIT_WORKER=external``
    says it runs somewhere else (another machine, a container) so this app cannot see it.
    """
    if os.getenv("LIVEKIT_WORKER", "").strip().lower() in {"external", "1", "true", "on", "yes"}:
        return "external"
    try:
        age = time.time() - heartbeat_path().stat().st_mtime
    except OSError:
        return "missing"
    return "alive" if age < _HEARTBEAT_MAX_AGE_S else "missing"


WORKER_MISSING_HINT = (
    "The LiveKit voice worker is not running. Start the app with ./run.sh (it starts the worker), "
    "or set LIVEKIT_WORKER=external if it runs somewhere else."
)


def _missing() -> list[str]:
    return [k for k in _ENV if not os.getenv(k, "").strip()]


class LiveKitTransport:
    name = "livekit"
    label = "LiveKit (hands-free)"

    def available(self) -> bool:
        return not _missing() and worker_state() != "missing"

    def describe(self) -> dict[str, Any]:
        missing = _missing()
        if missing:
            return {"name": self.name, "label": self.label, "available": False,
                    "reason": f"missing {', '.join(missing)} in .env"}
        check = check_credentials()
        if check["valid"] is False:
            return {"name": self.name, "label": self.label, "available": False, "reason": check["hint"]}
        if worker_state() == "missing":
            return {"name": self.name, "label": self.label, "available": False, "reason": WORKER_MISSING_HINT}
        return {"name": self.name, "label": self.label, "available": True, "reason": ""}

    def join(
        self, *, session_id: str, language: str, voice: dict[str, Any] | None = None,
        stt: str = "server",
    ) -> dict[str, Any]:
        missing = _missing()
        if missing:
            raise TransportUnavailable(f"LiveKit is not configured: missing {', '.join(missing)}")
        if worker_state() == "missing":
            raise TransportUnavailable(WORKER_MISSING_HINT)
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
