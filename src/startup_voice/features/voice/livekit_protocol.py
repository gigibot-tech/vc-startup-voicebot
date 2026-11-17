"""Wire protocol between the browser (voice-livekit.js) and the voice worker, over the LiveKit
room's data channel. Pure Python, no livekit import, so it is unit-tested without the SDK.

browser -> worker   topic ``sv.cmd``      worker -> browser   topic ``sv.evt``
  speak_begin {id}                          ready {stt, tts}
  speak_chunk {id, text}                    transcript {text}            final user turn
  speak_end {id}                            interim {text}               live words (not final)
  say {id, text}      one-shot              user_state {state}           speaking|listening|away
  speak_cancel                              agent_state {state}
  config {language}                         speak_done {id, interrupted}
                                            error {message}

The worker never sees the LLM. The browser sends reply text AFTER its own turn pipeline
produced it (chat.sendText -> /turn/stream), so bubbles, review gate and dossier stay exactly
as in classic mode.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import Any, Protocol

TOPIC_CMD = "sv.cmd"
TOPIC_EVT = "sv.evt"


def encode(msg: dict[str, Any]) -> bytes:
    return json.dumps(msg, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def decode(payload: bytes | str) -> dict[str, Any] | None:
    """Parse one data packet; anything that is not a JSON object with a ``t`` is ignored."""
    try:
        raw = payload.decode("utf-8") if isinstance(payload, (bytes, bytearray)) else payload
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("t"), str) else None


class SpeakStream:
    """Reply text pushed piece by piece; async-iterable, so it can be handed to ``session.say``."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()
        self.closed = False
        self.cancelled = False

    def push(self, text: str) -> None:
        if text and not self.closed:
            self._queue.put_nowait(text)

    def end(self) -> None:
        if not self.closed:
            self.closed = True
            self._queue.put_nowait(None)

    def cancel(self) -> None:
        """Stop accepting text (the user talked over the agent). Later pushes are dropped."""
        self.cancelled = True
        self.end()

    def __aiter__(self) -> SpeakStream:
        return self

    async def __anext__(self) -> str:
        item = await self._queue.get()
        if item is None:
            raise StopAsyncIteration
        return item


class SpeechHandleLike(Protocol):
    interrupted: bool

    def interrupt(self) -> Any: ...
    def add_done_callback(self, callback: Callable[[Any], None]) -> None: ...


class SpeakCoordinator:
    """Turns ``speak_*`` commands into one speech at a time.

    ``say(text_or_stream)`` starts playout and returns a handle (livekit ``SpeechHandle``);
    ``emit(event)`` sends an event to the browser. A new ``speak_begin`` replaces the running
    speech; text for an old / interrupted id is dropped, never spoken late.
    """

    def __init__(
        self,
        *,
        say: Callable[[Any], SpeechHandleLike],
        emit: Callable[[dict[str, Any]], None],
    ) -> None:
        self._say = say
        self._emit = emit
        self._current: tuple[int, SpeakStream, SpeechHandleLike] | None = None

    def handle(self, cmd: dict[str, Any]) -> None:
        kind = cmd.get("t")
        if kind == "speak_cancel":
            self.cancel()
            return
        if kind not in {"speak_begin", "speak_chunk", "speak_end", "say"}:
            return
        try:
            sid = int(cmd.get("id"))
        except (TypeError, ValueError):
            return
        if kind == "speak_begin":
            self._begin(sid)
        elif kind == "say":
            self._begin(sid)
            self._push(sid, str(cmd.get("text") or ""))
            self._end(sid)
        elif kind == "speak_chunk":
            self._push(sid, str(cmd.get("text") or ""))
        else:
            self._end(sid)

    def cancel(self) -> None:
        if self._current is None:
            return
        _, stream, handle = self._current
        self._current = None
        stream.cancel()
        handle.interrupt()

    def _begin(self, sid: int) -> None:
        self.cancel()
        stream = SpeakStream()
        try:
            handle = self._say(stream)
        except Exception as exc:  # session closed / TTS not ready: tell the browser, don't crash
            self._emit({"t": "error", "message": f"speech failed: {exc}"})
            self._emit({"t": "speak_done", "id": sid, "interrupted": True})
            return
        self._current = (sid, stream, handle)

        def done(h: Any, sid: int = sid, stream: SpeakStream = stream) -> None:
            # A user interruption ends the handle: refuse any text that is still arriving.
            stream.cancel()
            if self._current and self._current[0] == sid:
                self._current = None
            self._emit({"t": "speak_done", "id": sid, "interrupted": bool(h.interrupted)})

        handle.add_done_callback(done)

    def _push(self, sid: int, text: str) -> None:
        if self._current and self._current[0] == sid:
            self._current[1].push(text)

    def _end(self, sid: int) -> None:
        if self._current and self._current[0] == sid:
            self._current[1].end()
