"""Interview feature - HTTP routes. The ONLY routes that make the LLM do work.

BUTTON -> BACKEND FLOWS  (browser code: features/interview/ui/chat.js + config-editor.js)
=========================================================================================

[Senden]  (#sendBtn)   /   [Enter] in the text box   /   [Sprechen] (mic, after speech-to-text)
    All three end in the same JS function, chat.js sendText(text).
    (The mic itself never calls the LLM; voice.js only hands over a transcript.)

      browser   sendText() -> POST /api/sessions/{id}/turn/stream   {"text": "..."}
      here      turn_stream()          SSE framing + error events
      pipeline  InterviewPipeline.stream_turn()
                  1. LLM call #1 EXTRACT  complete()  -> dossier slots filled, re-scored
                  2. LLM call #2 REPLY    stream()    -> chunks
                  3. save turn to disk (only after the last chunk)
      browser   <- event: delta {text} ... then event: done {session, reply}
                   bubble grows per delta; on done the dossier repaints and voice.speak(reply) runs.

    POST /turn (same logic, no streaming, one JSON answer) is kept for API clients and tests.

[Dossier abschließen]  (#finalizeBtn, dossier panel)
    dossier/ui/actions.js finalize() asks confirm() if the dossier is incomplete, then
      -> POST /api/sessions/{id}/finalize  -> finalize() below
      -> InterviewPipeline.finalize_session(): re-score, LLM call SUMMARY (complete()),
         mark finalized, append the spoken summary, save.
      <- {session, reply}. The UI then returns to the picker.

[Prompt speichern] / [Defaults]   (#savePromptBtn / #resetPromptBtn, Einstellungen > System-Prompt)
[Katalog speichern] / [Defaults]  (#saveCatalogBtn / #resetCatalogBtn, Fragenkatalog)
    interview/ui/config-editor.js
      save  -> PUT  /api/interview-config   {greeting, reply_system_prompt, slot_questions}
               put_interview_config() -> InterviewConfigStore.save() (normalizes empties to defaults)
      reset -> POST /api/interview-config/reset -> deletes the saved file, returns the defaults.
      Both return the config the UI then repaints. No LLM call. Takes effect on the NEXT turn.

(no button) PersonaPlex voice agent calling back: POST /api/sessions/{id}/tool-webhook
    -> InterviewPipeline.apply_tool_update(): writes the given facts into a slot, re-scores,
       LLM REPLY call, returns the next question as ``inject_text`` for the voice agent.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from startup_voice.features.interview.config import InterviewConfig, InterviewConfigStore
from startup_voice.features.interview.pipeline import InterviewPipeline
from startup_voice.features.sessions.registry import SessionRegistry
from startup_voice.features.voice import parse_tool_webhook_body


class TurnBody(BaseModel):
    text: str = Field(min_length=1)


def _sse(event: str, data: dict) -> str:
    """One Server-Sent Event: "event:" + "data:" lines, terminated by a BLANK line."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def build_router(
    *,
    registry: SessionRegistry,
    pipeline: InterviewPipeline,
    config_store: InterviewConfigStore,
) -> APIRouter:
    router = APIRouter(tags=["interview"])

    # ------------------------------------------------------------------
    # TURN routes - the ONLY routes that call the LLM for a user message.
    # Input is always plain text (typed, or already transcribed by STT in
    # the browser). The server cannot tell the difference, by design.
    # ------------------------------------------------------------------

    @router.post("/api/sessions/{session_id}/turn")
    def turn(session_id: str, body: TurnBody) -> dict:
        """Non-streaming turn: blocks until the full reply exists, returns JSON.

        Same pipeline as ``turn_stream`` (``process_turn`` vs ``stream_turn``).
        The shipped UI does not use it any more; kept for API clients and tests.
        """
        try:
            session = pipeline.process_turn(registry.get(session_id), body.text)
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(502, f"LLM turn failed: {exc}") from exc
        registry.put(session)
        reply = session.messages[-1].content if session.messages else ""
        return {"session": session.model_dump(), "reply": reply}

    @router.post("/api/sessions/{session_id}/turn/stream")
    def turn_stream(session_id: str, body: TurnBody) -> StreamingResponse:
        """Streaming turn (Server-Sent Events). THE endpoint the browser uses.

        Caller : interview/ui/chat.js ``sendText()`` via ``apiStream()``.
        Request: ``{"text": "<what the founder said or typed>"}``

        Response is ``text/event-stream``. Each event is two lines + blank line::

            event: delta
            data: {"text": "Danke. "}            <- repeated, one per LLM chunk

            event: done
            data: {"session": {...}, "reply": "Danke. Wie gross ist der Markt?"}

            event: error                         <- instead of ``done`` on failure
            data: {"message": "LLM turn failed: ..."}

        Contract: exactly one terminal event (``done`` or ``error``) per request.
        The turn is written to disk only on success. On ``error`` the cached
        in-memory session already contains the user message (it is mutated
        before the LLM replies), and the client keeps whatever partial text it
        painted.

        Why a sync ``def`` generator: Starlette runs it in a threadpool, so the
        blocking httpx calls to the LLM do not stall the event loop.
        """
        session = registry.get(session_id)

        def events() -> Iterator[str]:
            try:
                # stream_turn() runs LLM call #1 (extract) to completion first, so
                # the first `delta` only appears after that; then call #2 streams.
                for chunk in pipeline.stream_turn(session, body.text):
                    yield _sse("delta", {"text": chunk})
            except Exception as exc:
                yield _sse("error", {"message": f"LLM turn failed: {exc}"})
                return
            registry.put(session)
            reply = session.messages[-1].content if session.messages else ""
            yield _sse("done", {"session": session.model_dump(), "reply": reply})

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            # no-cache + X-Accel-Buffering: stop proxies (nginx) from buffering the
            # stream, which would make chunks arrive all at once.
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @router.post("/api/sessions/{session_id}/tool-webhook")
    def tool_webhook(session_id: str, body: dict) -> dict:
        """PersonaPlex callback: store facts the voice agent heard, get the next question back."""
        session = registry.get(session_id)
        try:
            slot, fields, summary, evidence = parse_tool_webhook_body(body)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        session = pipeline.apply_tool_update(
            session, slot=slot, fields=fields, summary=summary, evidence=evidence
        )
        registry.put(session)
        inject = session.messages[-1].content if session.messages else ""
        return {
            "ok": True,
            "evaluation": session.evaluation.model_dump(),
            "inject_text": inject,
            "finalized": session.finalized,
        }

    @router.post("/api/sessions/{session_id}/finalize")
    def finalize(session_id: str) -> dict:
        """[Dossier abschließen] - LLM writes the spoken summary, session is marked finalized."""
        session = pipeline.finalize_session(registry.get(session_id))
        registry.put(session)
        return {"session": session.model_dump(), "reply": session.spoken_summary}

    # ------------------------------------------------------------------
    # Interview config: the editable prompt, greeting and question catalog.
    # No LLM call here; the new values are used from the next turn on.
    # ------------------------------------------------------------------

    @router.get("/api/interview-config")
    def get_interview_config() -> dict:
        """Load current config for the two editor panels."""
        return config_store.load().model_dump()

    @router.put("/api/interview-config")
    def put_interview_config(body: InterviewConfig) -> dict:
        """[Prompt speichern] / [Katalog speichern]"""
        return config_store.save(body).model_dump()

    @router.post("/api/interview-config/reset")
    def reset_interview_config() -> dict:
        """[Defaults] - drop the saved file and return the built-in defaults."""
        return config_store.reset().model_dump()

    return router
