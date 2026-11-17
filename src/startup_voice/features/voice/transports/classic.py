"""Classic mode: push-to-talk in the browser (Web Speech / Whisper / cloud STT + TTS via /api/tts).

Nothing to configure server-side, so it is always available and is the fallback for every
other mode. All the work happens in features/voice/ui/voice.js.
"""

from __future__ import annotations

from typing import Any


class ClassicTransport:
    name = "classic"
    label = "Classic (push-to-talk)"

    def available(self) -> bool:
        return True

    def describe(self) -> dict[str, Any]:
        return {"name": self.name, "label": self.label, "available": True, "reason": ""}

    def join(
        self, *, session_id: str, language: str, voice: dict[str, Any] | None = None,
        stt: str = "server",
    ) -> dict[str, Any]:
        return {"mode": self.name}
