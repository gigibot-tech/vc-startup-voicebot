"""InterviewPipeline — the ONLY orchestrator that calls the LLM.

Voice / STT / TTS never import this module. Composition root: web.py.

Per user turn — reply FIRST (Thinking…), then dossier extract ALWAYS after the reply:

    #1 REPLY     stream() / complete()      → next analyst question (+ trailing markers)
    #2 EXTRACT   complete(json_mode=True)   → dossier fields + evaluation (every turn)

UI order is fixed: Thinking… → spoken reply → Updating dossier…
SSE: reply chunks → ReplyDone (TTS + mic unlock, needs_extract=True) → EXTRACT_PHASE → done.
Reply fields (ASK_1/ASK_2) come from the *prior* extract and skip last turn's fields.
``refresh_evaluation`` runs after mutations — ``FileSessionStore.save`` does not re-score.

Side paths:
    resolve_proposals / apply_tool_update  → SCORE_BELEGE (json_mode) then refresh_evaluation
    finalize_session                       → SUMMARY (uses current evaluation)
"""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

from startup_voice.domain import (
    SLOT_ORDER,
    DimensionState,
    InterviewSession,
    field_label,
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
    EXTRACT_DELTA_SYSTEM,
    EXTRACT_SYSTEM,
    SCORE_BELEGE_SYSTEM,
    SUMMARY_SYSTEM,
    build_extract_user,
    build_reply_prompt,
    build_score_belege_user,
    end_allowed,
    field_hint,
    is_repeat,
    fallback_question,
    looks_german,
    previous_assistant_message,
    repeats_question,
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


def _carry_greeting(session: InterviewSession) -> str:
    """First line of a carried conversation: dossier is here, name the open gaps."""
    labels: list[str] = []
    for item in session.evaluation.missing_fields[:4]:
        slot, _, key = item.partition(".")
        if slot in SLOT_ORDER and key:
            labels.append(field_label(slot, key))  # type: ignore[arg-type]
    if normalize_language(session.language) == "en":
        if labels:
            return "New conversation. The dossier came along. Still open: " + ", ".join(labels) + "."
        return "New conversation. The dossier came along and looks complete. What should we dig into?"
    if labels:
        return "Neues Gespräch. Das Dossier ist übernommen. Offen ist noch: " + ", ".join(labels) + "."
    return "Neues Gespräch. Das Dossier ist übernommen und sieht vollständig aus. Wobei soll ich nachhaken?"


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
        self._extract_locks: dict[str, threading.Lock] = {}
        self._extract_locks_guard = threading.Lock()

    def _extract_lock(self, session: InterviewSession) -> threading.Lock:
        """One dossier update at a time per session.

        The next spoken reply does NOT wait for the previous dossier update (the founder keeps
        talking while it runs); only the updates queue up behind each other, in turn order.
        """
        with self._extract_locks_guard:
            return self._extract_locks.setdefault(session.id, threading.Lock())

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

    def carry_dossier(self, source: InterviewSession) -> tuple[InterviewSession, str]:
        """New conversation with a copy of the dossier and no prior transcript.

        The source session stays as it is. Versions, conflicts and chat do not move.
        """
        language = normalize_language(source.language)
        mode = (source.followup_mode or DEFAULT_FOLLOWUP_MODE).strip().lower()
        if mode not in FOLLOWUP_MODES:
            mode = DEFAULT_FOLLOWUP_MODE
        session = InterviewSession.create(language=language, followup_mode=mode)
        session.objects = {
            slot: source.objects[slot].model_copy(deep=True) for slot in SLOT_ORDER
        }
        for state in session.objects.values():
            state.updated_at_turn = 0
        refresh_evaluation(session)
        greeting = _carry_greeting(session)
        session.messages.append(TurnMessage(role="assistant", content=greeting))
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

    def _continue_prompt_parts(
        self, session: InterviewSession
    ) -> tuple[str, str, SlotId]:
        """Build continue-question prompts (shared by server LLM and browser prepare)."""
        refresh_evaluation(session)
        ev = session.evaluation
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
            # Topics, never "slot.field" keys (small models read keys aloud) — see field_hint().
            f"Missing topics overall: {'; '.join(field_hint(k) for k in (ev.missing_fields or [])) or 'none (all filled — probe depth/numbers)'}\n"
            f"Dossier so far: {json.dumps(dossier_dump, ensure_ascii=False)}\n"
            f"Recent transcript:\n{recent_history(session, last=6)}\n"
            f"Do NOT repeat: {prev_q[:240]}"
        )
        return system, user, target

    def continue_interview(self, session: InterviewSession) -> tuple[InterviewSession, str]:
        """Generate the next deeper analyst question when the user clicks 'Weiter fragen'."""
        system, user, _target = self._continue_prompt_parts(session)
        raw = self._complete(system, user, max_tokens=reply_token_budget()).strip()
        return self.commit_continue(session, raw)

    def prepare_continue(self, session: InterviewSession) -> dict[str, Any]:
        """Prompts for browser LLM continue-asking (no model call)."""
        system, user, target = self._continue_prompt_parts(session)
        self._store.save(session)
        return {
            "target": target,
            "reply_system": system,
            "reply_user": user,
            "reply_max_tokens": reply_token_budget(),
            "session": session.model_dump(),
        }

    def commit_continue(
        self, session: InterviewSession, raw_reply: str
    ) -> tuple[InterviewSession, str]:
        """Persist a browser- or server-produced continue question."""
        question, _, _ = split_reply_marks(raw_reply)
        if not question:
            raise RuntimeError("LLM returned empty follow-up question")
        question = self._guard_repeat(
            session,
            question,
            previous=next((m.content for m in reversed(session.messages) if m.role == "assistant"), ""),
        )
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

    def prepare_client_turn(self, session: InterviewSession, user_text: str) -> dict[str, Any]:
        """Record the user line and return reply+extract prompts for a browser LLM.

        Same prompt builders as ``process_turn`` / ``stream_turn`` — no model call here.
        If the session already ends with the same user line (e.g. Retry), reuse it instead
        of stacking duplicate user bubbles.
        """
        cleaned = user_text.strip()
        if (
            session.messages
            and session.messages[-1].role == "user"
            and session.messages[-1].content == cleaned
        ):
            focus = (session.evaluation.next_focus_slot if session.evaluation else None) or "team"
        else:
            focus = self._begin_user_turn(session, user_text)
        ask = (session.evaluation.next_focus_slot if session.evaluation else None) or focus
        reply_system, reply_user = self._preprocess_reply(session, user_text, ask)
        ext_mode = (self.config().extract_mode or "full").strip().lower()
        extract_sys = EXTRACT_DELTA_SYSTEM if ext_mode == "delta" else EXTRACT_SYSTEM
        extract_user = build_extract_user(session, user_text, focus, extract_mode=ext_mode)
        self._store.save(session)
        return {
            "focus": focus,
            "reply_system": reply_system,
            "reply_user": reply_user,
            "extract_system": extract_sys,
            "extract_user": extract_user,
            "reply_max_tokens": reply_token_budget(user_text),
            "extract_max_tokens": extract_token_budget(user_text),
            "turn_index": session.turn_index,
            "session": session.model_dump(),
        }

    def commit_client_reply(
        self, session: InterviewSession, raw_reply: str
    ) -> tuple[InterviewSession, str, bool]:
        """Persist the spoken reply right after Call #1 (before browser Call #2 extract runs)."""
        reply, _mark_extract, offer_end = split_reply_marks(raw_reply)
        offer_end = offer_end and end_allowed(session)  # a small model's [[intake:end]] may be premature
        if not reply:
            raise RuntimeError("LLM returned empty reply")
        if session.evaluation and session.evaluation.ready_for_closing:
            offer_end = True
        if (
            session.messages
            and session.messages[-1].role == "assistant"
            and session.messages[-1].content == reply
        ):
            return session, reply, offer_end
        reply = self._guard_repeat(
            session, reply, previous=previous_assistant_message(session), offer_end=offer_end
        )
        session.messages.append(TurnMessage(role="assistant", content=reply))
        self._store.save(session)
        return session, reply, offer_end

    def commit_client_turn(
        self,
        session: InterviewSession,
        *,
        raw_reply: str,
        raw_extract: str,
        user_text: str | None = None,
    ) -> tuple[InterviewSession, str, bool]:
        """Apply browser LLM reply + extract through the same review/score gate as server turns."""
        text = (user_text or "").strip()
        if not text:
            for m in reversed(session.messages):
                if m.role == "user":
                    text = m.content
                    break
        session, reply, offer_end = self.commit_client_reply(session, raw_reply)
        updates, belege = _parse_extract(raw_extract)
        touched = apply_extract_updates(
            session, updates, belege, turn=session.turn_index, source="chat"
        )
        eval_result = refresh_evaluation(session)
        if eval_result.ready_for_closing:
            offer_end = True
        self._persist_turn(
            session, text, touched, eval_result, reply, append_reply=False
        )
        return session, reply, offer_end

    def process_turn(self, session: InterviewSession, user_text: str) -> InterviewSession:
        focus = self._begin_user_turn(session, user_text)
        ask = (session.evaluation.next_focus_slot if session.evaluation else None) or focus
        raw_reply = self._run_reply(session, user_text, ask)
        reply, _mark_extract, offer_end = split_reply_marks(raw_reply)
        offer_end = offer_end and end_allowed(session)  # a small model's [[intake:end]] may be premature
        if not reply:
            raise RuntimeError("LLM returned empty reply")
        reply = self._guard_repeat(
            session, reply, previous=previous_assistant_message(session), offer_end=offer_end
        )
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

        Two sequential LLM calls per turn:
          • Call #1 (REPLY)   : build_reply_prompt() -> stream() tokens -> ReplyDone (TTS starts)
          • Call #2 (EXTRACT) : EXTRACT_SYSTEM + build_extract_user() -> complete(json_mode=True)
        """
        focus = self._begin_user_turn(session, user_text)
        ask = (session.evaluation.next_focus_slot if session.evaluation else None) or focus

        # ── CALL #1: Spoken analyst reply (streamed to chat bubble + TTS) ──────
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
        offer_end = offer_end and end_allowed(session)  # a small model's [[intake:end]] may be premature
        if not reply:
            raise RuntimeError("LLM returned empty reply")
        reply = self._guard_repeat(
            session, reply, previous=previous_assistant_message(session), offer_end=offer_end
        )
        if session.evaluation and session.evaluation.ready_for_closing:
            offer_end = True
        session.messages.append(
            TurnMessage(role="assistant", content=reply, warning=self._last_llm_warning())
        )
        self._store.save(session)
        # Unlock UI & start TTS before Call #2 begins.
        yield ReplyDone(reply=reply, needs_extract=True, offer_end=offer_end)

        # ── CALL #2: Silent 5-slot JSON dossier extraction ─────────────────────
        yield EXTRACT_PHASE
        with self._extract_lock(session):  # waits only for an earlier turn's update, never for a reply
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

    def refresh_dossier_extract(self, session: InterviewSession) -> InterviewSession:
        """On-demand extract: full conversation, focused on open coverage gaps."""
        user_turns = [m.content.strip() for m in session.messages if m.role == "user" and (m.content or "").strip()]
        founder_text = "\n".join(user_turns)
        if not founder_text:
            refresh_evaluation(session)
            self._store.save(session)
            return session
        with self._extract_lock(session):
            updated, eval_result = self._run_extract(
                session, founder_text, focus="team", full_transcript=True
            )
            reply = next(
                (m.content for m in reversed(session.messages) if m.role == "assistant"),
                "",
            )
            return self._persist_turn(
                session, founder_text, updated, eval_result, reply, append_reply=False
            )

    def prepare_extract_only(self, session: InterviewSession) -> dict[str, Any]:
        """Return MISSING_FOCUS + full-transcript prompts for on-demand browser extract."""
        user_turns = [m.content.strip() for m in session.messages if m.role == "user" and (m.content or "").strip()]
        founder_text = "\n".join(user_turns)
        extract_user = build_extract_user(
            session, founder_text, "team", extract_mode="full", full_transcript=True
        )
        return {
            "focus": "team",
            "extract_system": EXTRACT_SYSTEM,
            "extract_user": extract_user,
            "extract_max_tokens": extract_token_budget(extract_user),
        }

    def commit_extract_only(self, session: InterviewSession, raw_extract: str) -> InterviewSession:
        """Apply raw extract JSON from on-demand browser LLM dossier extraction."""
        user_turns = [m.content.strip() for m in session.messages if m.role == "user" and (m.content or "").strip()]
        founder_text = "\n".join(user_turns)
        updates, belege = _parse_extract(raw_extract)
        touched = apply_extract_updates(
            session, updates, belege, turn=session.turn_index, source="chat"
        )
        eval_result = refresh_evaluation(session)
        reply = next(
            (m.content for m in reversed(session.messages) if m.role == "assistant"),
            "",
        )
        return self._persist_turn(
            session, founder_text, touched, eval_result, reply, append_reply=False
        )

    def _run_extract(
        self,
        session: InterviewSession,
        user_text: str,
        *,
        focus: SlotId = "team",
        full_transcript: bool = False,
    ) -> tuple[list[SlotId], StepEvaluation]:
        """LLM extract into dossier (every turn after reply, or on-demand full scan)."""
        ext_mode = "full" if full_transcript else (self.config().extract_mode or "full").strip().lower()
        extract_sys = EXTRACT_DELTA_SYSTEM if ext_mode == "delta" else EXTRACT_SYSTEM
        user = build_extract_user(
            session,
            user_text,
            focus,
            extract_mode=ext_mode,
            full_transcript=full_transcript,
        )
        budget_src = user if full_transcript else user_text
        raw = self._complete(
            extract_sys,
            user,
            max_tokens=extract_token_budget(budget_src),
            json_mode=True,
        )
        updates, belege = _parse_extract(raw)
        touched = apply_extract_updates(
            session, updates, belege, turn=session.turn_index, source="chat"
        )
        return touched, refresh_evaluation(session)

    def _guard_repeat(
        self, session: InterviewSession, reply: str, *, previous: str, offer_end: bool = False
    ) -> str:
        """Never leave a dead end and never ask the same thing twice.

        Small models (Granite 4 3B, LFM3 1.7B) copy earlier assistant text, re-ask last turn's
        questions behind a new lead-in, or only acknowledge. In those cases the reply is replaced
        by ``fallback_question``: two precise questions for the topics Python picked this turn.
        """
        fallback = fallback_question(session) or self.config().question_for(
            (session.evaluation.next_focus_slot or "team")  # type: ignore[arg-type]
        )
        # Wrong language (a small model drifted to English in a German session): ask the German question.
        if (session.language or "de").lower().startswith("de") and not looks_german(reply):
            return fallback
        # No question although fields are open (and this is no wrap-up).
        if "?" not in reply and not offer_end and not end_allowed(session):
            return fallback
        if is_repeat(reply, previous) or repeats_question(reply, previous):
            return fallback if not is_repeat(fallback, previous) else reply
        return reply

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
            reply_system_prompt=cfg.reply_system_prompt,
            followup_mode=self._session_followup_mode(session),
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
