"""The one interface every voice mode implements (so modes can be swapped, never mixed up).

A *transport* only answers two questions for the browser:

  * is this mode usable right now (keys / server configured)?   -> ``describe()``
  * what does the browser need to start it for this session?    -> ``join()``

A transport NEVER talks to the LLM. What happens with a transcript is decided by the
browser (``chat.sendText``), the same for every mode. See features/voice/routes.py.
"""

from __future__ import annotations

from typing import Any, Protocol


class TransportUnavailable(RuntimeError):
    """Raised by ``join()`` when the mode is not configured. The message is user-facing."""


class VoiceTransport(Protocol):
    #: id used in ``VOICE_MODE`` and the browser pref ``voiceMode``
    name: str
    #: short label for the settings dropdown
    label: str

    def available(self) -> bool:
        """True when everything this mode needs is configured (no network probe)."""
        ...

    def describe(self) -> dict[str, Any]:
        """``{name, label, available, reason}`` — ``reason`` explains what is missing."""
        ...

    def join(
        self, *, session_id: str, language: str, voice: dict[str, Any] | None = None,
        stt: str = "server",
    ) -> dict[str, Any]:
        """``stt``: "server" (worker listens) or "browser" (browser transcribes, worker only speaks).

        Client config for the browser driver of this mode. Raises ``TransportUnavailable``."""
        ...
