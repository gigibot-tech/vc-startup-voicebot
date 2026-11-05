"""InterviewPipeline — the ONLY orchestrator that calls the LLM.

Voice / STT / TTS never import this module. Composition root: web.py.

Per user turn — reply FIRST (Thinking…), then dossier extract ALWAYS after the reply:

    #1 REPLY     stream() / complete()      → next analyst question (+ trailing markers)
    #2 EXTRACT   complete(json_mode=True)   → dossier fields + evaluation (every turn)

UI order is fixed: Thinking… → spoken reply → Updating dossier…
SSE: reply chunks → ReplyDone (TTS + mic unlock, needs_extract=True) → EXTRACT_PHASE → done.
ASK_NOW uses coverage from the *prior* extract (no keyword topic guessing).
``refresh_evaluation`` runs after mutations — ``FileSessionStore.save`` does not re-score.

Side paths:
    resolve_proposals / apply_tool_update  → SCORE_BELEGE (json_mode) then refresh_evaluation
    finalize_session                       → SUMMARY (uses current evaluation)
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from startup_voice.domain import (
    SLOT_ORDER,
    DimensionState,
    InterviewSession,
    LLM,
    SlotId,
    StepEvaluation,
    StepSnapshot,
    TurnMessage,
)
from startup_voice.features.dossier.review import (
    Decision,
    apply_decisions,
    apply_extract_updates,
    merge_slot_update,
)
from startup_voice.features.dossier.scoring import (
    apply_belege_map,
    refresh_evaluation,
    slot_has_content,
)
from startup_voice.features.interview.config import (
    DEFAULT_FOLLOWUP_MODE,
    FOLLOWUP_MODES,
    InterviewConfig,
    InterviewConfigStore,
)
from startup_voice.features.interview.llm import extract_json_block
from startup_voice.features.interview.prompts import (
    CONTINUE_QUESTION_SYSTEM,
    DEFAULT_GREETING,
    DEFAULT_REPLY_SYSTEM,
    DEFAULT_SLOT_QUESTIONS,
    EXTRACT_SYSTEM,
    SCORE_BELEGE_SYSTEM,
    SUMMARY_SYSTEM,
    build_extract_user,
    build_reply_prompt,
    build_score_belege_user,
    recent_history,
    split_reply_marks,
)
from startup_voice.features.sessions.store import FileSessionStore
from startup_voice.language import builtin_greeting, normalize_language, summary_language_name

# Backward-compatible aliases for tests / imports.
_REPLY_SYS = DEFAULT_REPLY_SYSTEM
_SLOT_QUESTION_HINTS = DEFAULT_SLOT_QUESTIONS
GREETING = DEFAULT_GREETING

# Yielded by stream_turn after ReplyDone (SSE status hook for topbar process banner).
EXTRACT_PHASE = object()


def _env_int(name: str, default: int) -> int:
    try:
        return max(64, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def reply_token_budget(user_text: str = "") -> int:
    """Safety ceiling (~2× P99) for spoken reply + trailing markers — caps TTS cost/runaway."""
    base = _env_int("LLM_MAX_TOKENS_REPLY", 400)
    extra = min(120, len(user_text or "") // 20)
    return base + extra


def extract_token_budget(user_text: str = "") -> int:
    """Dynamic ceiling for silent 5-slot JSON extract (no TTS; must close JSON cleanly)."""
    base = _env_int("LLM_MAX_TOKENS_EXTRACT", 1600)
    extra = min(1000, len(user_text or "") // 2)
    return base + extra


def summary_token_budget() -> int:
    """Spoken finalize summary (4–6 sentences ≈ 150–250 tok; ~2.5× ceiling)."""
    return _env_int("LLM_MAX_TOKENS_SUMMARY", 650)


def score_belege_token_budget() -> int:
    return _env_int("LLM_MAX_TOKENS_BELEGE", 400)


@dataclass(frozen=True)
class ReplyDone:
    """Spoken reply is ready: persist messages, let the UI TTS + unlock mic; extract follows."""

    reply: str
    needs_extract: bool
    offer_end: bool = False


def _parse_extract(raw: str) -> tuple[dict[str, Any], dict[str, Any]]:
    """LLM #1 postprocess: raw text → (updates, belege). Merge is dossier-owned."""
    data = extract_json_block(raw)
    if data is None and raw.strip():
        print(f"[extract] unparsed JSON (raw_len={len(raw)} head={raw[:160]!r})", flush=True)
        return {}, {}
    data = data or {}
    updates: dict[str, Any] = data.get("updates") or {
        s: data[s] for s in SLOT_ORDER if isinstance(data.get(s), dict)
    }
    belege = data.get("belege") if isinstance(data.get("belege"), dict) else {}
    return updates, belege or {}


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

    def _complete(
        self, system: str, user: str, *, max_tokens: int, json_mode: bool = False
    ) -> str:
        try:
            return self._llm.complete(
                system, user, max_tokens=max_tokens, json_mode=json_mode
            )
        except TypeError:
            return self._llm.complete(system, user, max_tokens=max_tokens)

    def _last_llm_warning(self) -> str:
        meta = getattr(self._llm, "last_meta", None)
        if isinstance(meta, dict):
            return str(meta.get("warning") or "")
        return ""

    # -- session lifecycle ---------------------------------------------------

    def start_session(self, *, language: str = "de") -> tuple[InterviewSession, str]:
        language = normalize_language(language)
        cfg = self.config()
        greeting = builtin_greeting(language) or cfg.greeting
        mode = (cfg.followup_mode or DEFAULT_FOLLOWUP_MODE).strip().lower()
        if mode not in FOLLOWUP_MODES:
            mode = DEFAULT_FOLLOWUP_MODE
        session = InterviewSession.create(language=language, followup_mode=mode)
        session.messages.append(TurnMessage(role="assistant", content=greeting))
        refresh_evaluation(session)
        self._store.save(session)
        return session, greeting

    def clear_dossier(self, session: InterviewSession) -> InterviewSession:
        session.objects = {slot: DimensionState.blank(slot) for slot in SLOT_ORDER}
        session.finalized = False
        session.spoken_summary = ""
        refresh_evaluation(session)
        self._store.save(session)
        return session

    def finalize_session(self, session: InterviewSession) -> InterviewSession:
        refresh_evaluation(session)
        body = json.dumps(
            {s: session.objects[s].model_dump() for s in SLOT_ORDER}, ensure_ascii=False
        )
        system = SUMMARY_SYSTEM.format(language=summary_language_name(session.language))
        summary = self._complete(
            system, body, max_tokens=summary_token_budget()
        ).strip()
        if not summary:
            raise RuntimeError("LLM returned empty summary")
        session.spoken_summary = summary
        session.finalized = True
        session.messages.append(
            TurnMessage(role="assistant", content=summary, warning=self._last_llm_warning())
        )
        self._store.save_dossier_version(session)
        self._store.save(session)
        return session

    def continue_interview(self, session: InterviewSession) -> tuple[InterviewSession, str]:
        """Generate the next deeper analyst question when the user clicks 'Weiter fragen'."""
        refresh_evaluation(session)
        ev = session.evaluation
        # Pick incomplete slot first; otherwise the slot with lowest specificity/belege.
        target: SlotId = ev.next_focus_slot or min(
            SLOT_ORDER,
            key=lambda s: (
                float((ev.slot_coverage or {}).get(s, 1.0)),
                float((ev.slot_specificity or {}).get(s, 0.0)),
            ),
        )
        lang_name = summary_language_name(session.language)
        system = CONTINUE_QUESTION_SYSTEM.format(language=lang_name)
        dossier_dump = {
            s: {
                "fields": session.objects[s].fields,
                "summary": session.objects[s].summary,
                "coverage": (ev.slot_coverage or {}).get(s, 0.0),
                "specificity": (ev.slot_specificity or {}).get(s, 0.0),
            }
            for s in SLOT_ORDER
        }
        prev_q = next(
            (m.content for m in reversed(session.messages) if m.role == "assistant"),
            "",
        )
        user = (
            f"Target slot to probe deeper: {target}\n"
            f"Missing fields overall: {ev.missing_fields or 'none (all filled — probe depth/numbers)'}\n"
            f"Dossier so far: {json.dumps(dossier_dump, ensure_ascii=False)}\n"
            f"Recent transcript:\n{recent_history(session, last=6)}\n"
            f"Do NOT repeat: {prev_q[:240]}"
        )
        raw = self._complete(system, user, max_tokens=reply_token_budget()).strip()
        question, _, _ = split_reply_marks(raw)
        if not question:
            raise RuntimeError("LLM returned empty follow-up question")
        session.messages.append(
            TurnMessage(role="assistant", content=question, warning=self._last_llm_warning())
        )
        self._store.save(session)
        return session, question

    # -- main turn: REPLY (#1) then optional EXTRACT (#2) --------------------

    def _begin_user_turn(self, session: InterviewSession, user_text: str) -> SlotId:
        """Record the user line; return focus from the *prior* evaluation (pre-extract)."""
        session.messages.append(TurnMessage(role="user", content=user_text.strip()))
        session.turn_index += 1
        return (session.evaluation.next_focus_slot if session.evaluation else None) or "team"

    def process_turn(self, session: InterviewSession, user_text: str) -> InterviewSession:
        focus = self._begin_user_turn(session, user_text)
        ask = (session.evaluation.next_focus_slot if session.evaluation else None) or focus
        raw_reply = self._run_reply(session, user_text, ask)
        reply, _mark_extract, offer_end = split_reply_marks(raw_reply)
        if not reply:
            raise RuntimeError("LLM returned empty reply")
        if session.evaluation and session.evaluation.ready_for_closing:
            offer_end = True
        session.messages.append(
            TurnMessage(role="assistant", content=reply, warning=self._last_llm_warning())
        )
        self._store.save(session)
        # Dossier always after the spoken reply (Thinking… → reply → Updating dossier…).
        updated, eval_result = self._run_extract(session, user_text, focus=focus)
        ext_warn = self._last_llm_warning()
        if ext_warn and session.messages and session.messages[-1].role == "assistant":
            prev_w = session.messages[-1].warning
            session.messages[-1].warning = f"{prev_w} · Extract: {ext_warn}" if prev_w else f"Extract: {ext_warn}"
        if eval_result.ready_for_closing:
            offer_end = True
        return self._persist_turn(
            session, user_text, updated, eval_result, reply, append_reply=False
        )

    def stream_turn(self, session: InterviewSession, user_text: str) -> Iterator[Any]:
        """Yield reply chunks → ReplyDone → EXTRACT_PHASE → persist.

        Thinking/reply always first; dossier extract always runs after the reply unlocks.
        """
        focus = self._begin_user_turn(session, user_text)
        ask = (session.evaluation.next_focus_slot if session.evaluation else None) or focus
        system, user = self._preprocess_reply(session, user_text, ask)
        budget = reply_token_budget(user_text)
        stream = getattr(self._llm, "stream", None)
        chunks = (
            stream(system, user, max_tokens=budget)
            if stream
            else iter([self._complete(system, user, max_tokens=budget)])
        )
        parts: list[str] = []
        for chunk in chunks:
            if not parts:
                chunk = chunk.lstrip()
            if chunk:
                parts.append(chunk)
                yield chunk
        raw_reply = "".join(parts).strip()
        reply, _mark_extract, offer_end = split_reply_marks(raw_reply)
        if not reply:
            raise RuntimeError("LLM returned empty reply")
        if session.evaluation and session.evaluation.ready_for_closing:
            offer_end = True
        session.messages.append(
            TurnMessage(role="assistant", content=reply, warning=self._last_llm_warning())
        )
        self._store.save(session)
        # Always extract after reply — UI: Thinking… → reply → Updating dossier…
        yield ReplyDone(reply=reply, needs_extract=True, offer_end=offer_end)
        yield EXTRACT_PHASE
        updated, eval_result = self._run_extract(session, user_text, focus=focus)
        ext_warn = self._last_llm_warning()
        if ext_warn and session.messages and session.messages[-1].role == "assistant":
            prev_w = session.messages[-1].warning
            session.messages[-1].warning = f"{prev_w} · Extract: {ext_warn}" if prev_w else f"Extract: {ext_warn}"
        if eval_result.ready_for_closing:
            offer_end = True
        self._persist_turn(
            session, user_text, updated, eval_result, reply, append_reply=False
        )

    def _run_extract(
        self,
        session: InterviewSession,
        user_text: str,
        *,
        focus: SlotId = "team",
    ) -> tuple[list[SlotId], StepEvaluation]:
        """LLM extract into dossier (every turn after reply)."""
        user = build_extract_user(session, user_text, focus)
        raw = self._complete(
            EXTRACT_SYSTEM,
            user,
            max_tokens=extract_token_budget(user_text),
            json_mode=True,
        )
        updates, belege = _parse_extract(raw)
        touched = apply_extract_updates(
            session, updates, belege, turn=session.turn_index, source="chat"
        )
        return touched, refresh_evaluation(session)

    def _session_followup_mode(self, session: InterviewSession) -> str:
        """Prefer per-session setting; fall back to global config / default."""
        mode = (session.followup_mode or "").strip().lower()
        if mode in FOLLOWUP_MODES:
            return mode
        mode = (self.config().followup_mode or "").strip().lower()
        return mode if mode in FOLLOWUP_MODES else DEFAULT_FOLLOWUP_MODE

    def _preprocess_reply(
        self, session: InterviewSession, user_text: str, focus: SlotId | None
    ) -> tuple[str, str]:
        cfg = self.config()
        return build_reply_prompt(
            session,
            user_text,
            focus,
            reply_system_prompt=cfg.reply_system_prompt,
            followup_mode=self._session_followup_mode(session),
            slot_question=cfg.question_for(focus or "team"),
        )

    def _run_reply(
        self, session: InterviewSession, user_text: str, focus: SlotId | None
    ) -> str:
        system, user = self._preprocess_reply(session, user_text, focus)
        out = self._complete(
            system, user, max_tokens=reply_token_budget(user_text)
        ).strip()
        if not out:
            raise RuntimeError("LLM returned empty reply")
        return out

    def _persist_turn(
        self,
        session: InterviewSession,
        user_text: str,
        updated: list[SlotId],
        eval_result: StepEvaluation,
        reply: str,
        *,
        append_reply: bool = True,
    ) -> InterviewSession:
        if append_reply:
            session.messages.append(TurnMessage(role="assistant", content=reply))
        session.evaluation = eval_result
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

    # -- side paths ----------------------------------------------------------

    def resolve_proposals(
        self, session: InterviewSession, decisions: list[Decision]
    ) -> InterviewSession:
        """Apply old/new/manual — no LLM. Belege refresh on the next extract turn."""
        apply_decisions(session, decisions)
        refresh_evaluation(session)
        self._store.save(session)
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
        merge_slot_update(
            session.objects[slot],
            {"fields": fields or {}, "summary": summary, "evidence": evidence or []},
            turn=session.turn_index,
            source="tool",
        )
        self._score_belege(session, slots=[slot])
        eval_result = refresh_evaluation(session)
        focus = eval_result.next_focus_slot or slot
        reply = self._run_reply(session, summary or str(fields), focus)
        return self._persist_turn(
            session, f"[tool:{slot}] {summary or fields}", [slot], eval_result, reply
        )

    def _score_belege(self, session: InterviewSession, *, slots: list[SlotId]) -> None:
        if not any(slot_has_content(session.objects[s]) for s in slots):
            for s in slots:
                session.objects[s].belege = 0.0
            return
        raw = self._complete(
            SCORE_BELEGE_SYSTEM,
            build_score_belege_user(session, slots),
            max_tokens=score_belege_token_budget(),
            json_mode=True,
        )
        data = extract_json_block(raw) or {}
        apply_belege_map(session, data.get("belege") or data)
