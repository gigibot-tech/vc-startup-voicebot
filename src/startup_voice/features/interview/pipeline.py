"""Collect (fill objects) → score (evaluate) → reply — InterviewPipeline (LLM-only)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

from startup_voice.domain import (
    DIMENSIONS_SPEC,
    SLOT_ORDER,
    DimensionState,
    InterviewSession,
    LLM,
    SlotId,
    StepSnapshot,
    TurnMessage,
)
from startup_voice.features.interview.config import InterviewConfig, InterviewConfigStore
from startup_voice.features.interview.prompts import (
    DEFAULT_GREETING,
    DEFAULT_REPLY_SYSTEM,
    DEFAULT_SLOT_QUESTIONS,
    EXTRACT_SYSTEM,
    SUMMARY_SYSTEM,
)
from startup_voice.language import (
    builtin_greeting,
    normalize_language,
    reply_prompt_suffix,
    summary_language_name,
)
from startup_voice.features.interview.llm import extract_json_block
from startup_voice.features.dossier.review import Decision, apply_decisions, propose_field_update
from startup_voice.features.dossier.scoring import evaluate_session
from startup_voice.features.sessions.store import FileSessionStore

# Backward-compatible aliases for tests / imports.
_REPLY_SYS = DEFAULT_REPLY_SYSTEM
_SLOT_QUESTION_HINTS = DEFAULT_SLOT_QUESTIONS
GREETING = DEFAULT_GREETING


class InterviewPipeline:
    def __init__(
        self,
        llm: LLM,
        store: FileSessionStore,
        *,
        config_store: InterviewConfigStore | None = None,
    ) -> None:
        self._llm = llm
        self._store = store
        self._config_store = config_store

    def config(self) -> InterviewConfig:
        if self._config_store is not None:
            return self._config_store.load()
        return InterviewConfig().normalized()

    @property
    def llm(self) -> LLM:
        return self._llm

    def start_session(self, *, language: str = "de") -> tuple[InterviewSession, str]:
        language = normalize_language(language)
        greeting = builtin_greeting(language) or self.config().greeting
        session = InterviewSession.create(language=language)
        session.messages.append(TurnMessage(role="assistant", content=greeting))
        self._store.save(session)
        return session, greeting

    def process_turn(self, session: InterviewSession, user_text: str) -> InterviewSession:
        updated, eval_result = self._begin_turn(session, user_text)
        # Never auto-flip finalized — only explicit finalize_session marks "fertig".
        reply = self._decide_reply(session, user_text, eval_result.next_focus_slot)
        return self._finish_turn(session, user_text, updated, eval_result, reply)

    def stream_turn(self, session: InterviewSession, user_text: str) -> Iterator[str]:
        """Like process_turn, but yields reply chunks as generated.

        ENTRY POINT FOR EVERY USER MESSAGE, voice or typed. By the time text
        arrives here, any speech-to-text has already happened in the browser
        (voice.js); this layer only ever sees a plain string.

        Called by: web.py ``turn_stream()`` (HTTP/SSE). That handler turns each
        yielded chunk into an ``event: delta``.

        Two LLM calls per turn, in this order:

          1. EXTRACT  ``self._llm.complete(...)``  inside ``_begin_turn``
             Reads the founder's statement, fills dossier slots, rescores.
             NOT streamed: the JSON must be complete before it can be parsed.
             Hence the first chunk below appears only after this finishes.
          2. REPLY    ``self._llm.stream(...)``    right here
             Writes the agent's next question; yielded token by token.

        Persistence: nothing is saved until the iterator is EXHAUSTED. The last
        line (``_finish_turn``) appends the assistant message and writes the
        step snapshot. If the consumer stops early or the LLM fails mid-stream,
        no snapshot is written (the user message and extraction results remain
        on the in-memory ``session`` object though).

        Fallback: an LLM object without ``.stream()`` (e.g. a test stub) is
        called via ``.complete()`` and yields its whole reply as one chunk.
        """
        updated, eval_result = self._begin_turn(session, user_text)
        system, user = self._reply_prompt(session, user_text, eval_result.next_focus_slot)
        stream = getattr(self._llm, "stream", None)
        chunks = (
            stream(system, user, max_tokens=220)
            if stream
            else iter([self._llm.complete(system, user, max_tokens=220)])
        )
        parts: list[str] = []
        for chunk in chunks:
            if not parts:
                chunk = chunk.lstrip()
            if chunk:
                parts.append(chunk)
                yield chunk
        reply = "".join(parts).strip()
        if not reply:
            raise RuntimeError("LLM returned empty reply")
        self._finish_turn(session, user_text, updated, eval_result, reply)

    def _begin_turn(self, session: InterviewSession, user_text: str):
        """Phase 1 of a turn (shared by process_turn and stream_turn).

        Records the user message, runs LLM call #1 (extract -> dossier slots) and
        rescores. Mutates ``session`` in place. Returns (touched_slots, evaluation).
        """
        session.messages.append(TurnMessage(role="user", content=user_text.strip()))
        session.turn_index += 1
        prior_focus = (session.evaluation.next_focus_slot if session.evaluation else None) or "team"
        updated = self._fill_objects(session, user_text, focus=prior_focus)
        eval_result = evaluate_session(session)
        session.evaluation = eval_result
        return updated, eval_result

    def _finish_turn(
        self, session: InterviewSession, user_text: str, updated, eval_result, reply: str
    ) -> InterviewSession:
        """Phase 3 of a turn: append the assistant reply, snapshot, save to disk."""
        session.messages.append(TurnMessage(role="assistant", content=reply))
        step = StepSnapshot(
            turn_index=session.turn_index,
            user_input=user_text.strip(),
            updated_slots=updated,
            objects_state={k: v.model_copy(deep=True) for k, v in session.objects.items()},
            step_eval=eval_result,
            agent_reply=reply,
        )
        self._store.save(session, step=step)
        return session

    def apply_tool_update(
        self,
        session: InterviewSession,
        *,
        slot: SlotId,
        fields: dict[str, str] | None = None,
        summary: str = "",
        evidence: list[str] | None = None,
    ) -> InterviewSession:
        session.turn_index += 1
        state = session.objects[slot]
        for key, val in (fields or {}).items():
            if key in state.fields and val:
                propose_field_update(state, key, str(val), source="tool", turn=session.turn_index)
        if summary:
            state.summary = summary
        if evidence:
            state.evidence = list(dict.fromkeys([*state.evidence, *evidence]))
        req = DIMENSIONS_SPEC[slot].required_fields
        state.missing_or_vague = [f for f in req if not (state.fields.get(f) or "").strip()]
        state.updated_at_turn = session.turn_index
        eval_result = evaluate_session(session)
        session.evaluation = eval_result
        focus = eval_result.next_focus_slot or slot
        reply = self._decide_reply(session, summary or str(fields), focus)
        session.messages.append(TurnMessage(role="assistant", content=reply))
        step = StepSnapshot(
            turn_index=session.turn_index,
            user_input=f"[tool:{slot}] {summary or fields}",
            updated_slots=[slot],
            objects_state={k: v.model_copy(deep=True) for k, v in session.objects.items()},
            step_eval=eval_result,
            agent_reply=reply,
        )
        self._store.save(session, step=step)
        return session

    def finalize_session(self, session: InterviewSession) -> InterviewSession:
        session.evaluation = evaluate_session(session)
        session.spoken_summary = self._summarize(session)
        session.finalized = True
        session.messages.append(TurnMessage(role="assistant", content=session.spoken_summary))
        self._store.save(session)
        return session

    def resolve_proposals(
        self, session: InterviewSession, decisions: list[Decision]
    ) -> InterviewSession:
        """[Speichern] on proposal cards: apply the human's old/new/manual choices, rescore, save.

        No LLM call. Raises ValueError (nothing applied) if any decision is invalid.
        """
        apply_decisions(session, decisions)
        session.evaluation = evaluate_session(session)
        self._store.save(session)
        return session

    def clear_dossier(self, session: InterviewSession) -> InterviewSession:
        """Wipe slot fields for this session; keep id, created_at, and chat."""
        session.objects = {slot: DimensionState.blank(slot) for slot in SLOT_ORDER}
        session.finalized = False
        session.spoken_summary = ""
        session.evaluation = evaluate_session(session)
        self._store.save(session)
        return session

    def _fill_objects(
        self, session: InterviewSession, user_text: str, *, focus: SlotId = "team"
    ) -> list[SlotId]:
        prompt = (
            f"Transcript (context only):\n{self._history(session)}\n\n"
            f"Current focus slot: {focus}\n"
            f"Latest founder statement (SOURCE OF TRUTH):\n{user_text.strip()}"
        )
        raw = self._llm.complete(EXTRACT_SYSTEM, prompt, max_tokens=700)
        data = extract_json_block(raw) or {}
        # Small models sometimes drop the "updates" wrapper and return slots at top level.
        updates: dict[str, Any] = data.get("updates") or {
            s: data[s] for s in SLOT_ORDER if isinstance(data.get(s), dict)
        }
        touched: list[SlotId] = []
        for slot in SLOT_ORDER:
            if slot not in updates:
                continue
            self._merge_state(session.objects[slot], updates[slot] or {}, turn=session.turn_index)
            touched.append(slot)
        return touched

    @staticmethod
    def _is_leak(val: str) -> bool:
        v = val.strip().lower()
        return v.startswith("transcript so far") or "htgf-intake-analyst" in v[:120]

    def _merge_state(
        self, state: DimensionState, payload: dict[str, Any], *, turn: int, source: str = "chat"
    ) -> None:
        for key, val in (payload.get("fields") or {}).items():
            cleaned = str(val).strip()
            if key in state.fields and cleaned and not self._is_leak(cleaned):
                # The only write path for field values: conflicts become reviewable proposals.
                propose_field_update(state, key, cleaned, source=source, turn=turn)
        if payload.get("summary"):
            summary = str(payload["summary"]).strip()
            if summary and not self._is_leak(summary):
                state.summary = summary
        for item in payload.get("evidence") or []:
            text = str(item).strip()
            if text and not self._is_leak(text) and text not in state.evidence:
                state.evidence.append(text)
        req = DIMENSIONS_SPEC[state.slot].required_fields
        state.missing_or_vague = [
            f for f in req if not (state.fields.get(f) or "").strip()
        ]
        state.updated_at_turn = turn

    def _decide_reply(self, session: InterviewSession, user_text: str, focus: SlotId | None) -> str:
        system, user = self._reply_prompt(session, user_text, focus)
        out = self._llm.complete(system, user, max_tokens=220).strip()
        if not out:
            raise RuntimeError("LLM returned empty reply")
        return out

    def _reply_prompt(
        self, session: InterviewSession, user_text: str, focus: SlotId | None
    ) -> tuple[str, str]:
        focus = focus or "team"
        spec = DIMENSIONS_SPEC[focus]
        prev = next(
            (m.content for m in reversed(session.messages) if m.role == "assistant"),
            "",
        )
        cov = session.evaluation.slot_coverage or {}
        empty_slots = [s for s in SLOT_ORDER if float(cov.get(s) or 0) <= 0]
        phase = "breadth" if empty_slots else "depth"
        focus_state = session.objects[focus]
        missing_in_focus = [
            f for f in spec.required_fields if not (focus_state.fields.get(f) or "").strip()
        ]
        dossier = {
            s: {
                "fields": session.objects[s].fields,
                "summary": session.objects[s].summary,
                "status": session.objects[s].status,
                "coverage": cov.get(s, 0),
            }
            for s in SLOT_ORDER
        }
        cfg = self.config()
        slot_ask = cfg.question_for(focus) or ", ".join(spec.prompt_hints)
        user = (
            f"phase: {phase} (empty slots still: {empty_slots or 'none'}).\n"
            f"Focus dimension NOW: {focus} ({spec.label}) — ask only about this slot.\n"
            f"Missing fields in focus: {missing_in_focus or 'none'}.\n"
            f"ready_for_closing: {bool(session.evaluation.ready_for_closing)}.\n"
            f"Blueprint (paraphrase): {slot_ask}\n"
            f"Founder just said: {user_text[:700]}\n"
            f"Dossier so far: {json.dumps(dossier, ensure_ascii=False)}\n"
            f"Do NOT repeat: {prev[:240]}\n"
            + (
                "BREADTH: get a first full write-up for this still-empty/weak slot; "
                "do not re-ask Team if Product/Market/… are empty."
                if phase == "breadth"
                else "DEPTH: sharpen vague aspects; stay on focus."
            )
        )
        system = cfg.reply_system_prompt + reply_prompt_suffix(session.language)
        return system, user

    def _summarize(self, session: InterviewSession) -> str:
        body = json.dumps({s: session.objects[s].model_dump() for s in SLOT_ORDER}, ensure_ascii=False)
        system = SUMMARY_SYSTEM.format(language=summary_language_name(session.language))
        out = self._llm.complete(system, body, max_tokens=400).strip()
        if not out:
            raise RuntimeError("LLM returned empty summary")
        return out

    def _history(self, session: InterviewSession) -> str:
        return "\n".join(f"{m.role}: {m.content}" for m in session.messages[-8:])
