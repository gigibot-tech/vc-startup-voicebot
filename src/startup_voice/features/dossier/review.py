"""The ONE gate through which a LLM suggestion may change a dossier field (pure logic, no I/O).

WHY THIS EXISTS
===============
Before, every extraction silently overwrote the stored value. Now:

    propose_field_update()   called for EVERY machine-written value
                             (chat extraction, PersonaPlex tool webhook, PDF extraction)
        old value empty            -> written directly, nothing to review
        new value == old value     -> ignored (compared ignoring case/whitespace)
        otherwise                  -> parked in ``DimensionState.pending[field]``;
                                      ``fields[field]`` (and so the score) is NOT touched

    apply_decisions()        called by POST /api/sessions/{id}/dossier/resolve
        choice "old"     keep the accepted value, drop the proposal
        choice "new"     accept the LLM suggestion
        choice "manual"  accept the text the human typed/pasted (must not be empty)

Because every writer goes through here, "what is in the dossier" is always a value a human
either saw or never had to decide on (empty -> filled). Open proposals do not count for scoring.

``REVIEW_SOURCES`` is the policy knob: a source listed here asks for review on conflicts,
a source NOT listed overwrites silently (the old behaviour).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from startup_voice.domain import DimensionState, FieldProposal, InterviewSession

REVIEW_SOURCES = ("chat", "tool", "pdf")  # matched on the part before ":" ("pdf:<doc_id>" -> "pdf")

Choice = Literal["old", "new", "manual"]


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip()).casefold()


def propose_field_update(
    state: DimensionState,
    field: str,
    new: str,
    *,
    source: str,
    turn: int,
    quote: str = "",
    page: int | None = None,
) -> Literal["set", "same", "pending"]:
    """Offer ``new`` for ``state.fields[field]``. Returns what happened (useful for tests/logs)."""
    new = (new or "").strip()
    if field not in state.fields or not new:
        return "same"
    old = (state.fields.get(field) or "").strip()
    if not old:
        state.fields[field] = new
        state.pending.pop(field, None)
        return "set"
    if _norm(old) == _norm(new):
        state.pending.pop(field, None)  # the machine now agrees with the dossier again
        return "same"
    if source.split(":", 1)[0] not in REVIEW_SOURCES:
        state.fields[field] = new
        state.pending.pop(field, None)
        return "set"
    existing = state.pending.get(field)
    state.pending[field] = FieldProposal(
        old=existing.old if existing else old,  # keep the first "before" when proposals stack up
        new=new,
        source=source,
        quote=quote,
        page=page,
        turn=turn,
    )
    return "pending"


@dataclass(frozen=True)
class Decision:
    slot: str
    field: str
    choice: Choice
    manual_text: str = ""


def pending_count(session: InterviewSession) -> int:
    return sum(len(state.pending) for state in session.objects.values())


def apply_decisions(session: InterviewSession, decisions: list[Decision]) -> None:
    """Validate ALL decisions first, then apply them (all or nothing). Raises ValueError."""
    for d in decisions:
        state = session.objects.get(d.slot)  # type: ignore[call-overload]
        if state is None or d.field not in state.pending:
            raise ValueError(f"no open proposal for {d.slot}.{d.field}")
        if d.choice not in ("old", "new", "manual"):
            raise ValueError(f"invalid choice for {d.slot}.{d.field}: {d.choice!r}")
        if d.choice == "manual" and not d.manual_text.strip():
            raise ValueError(f"manual text is empty for {d.slot}.{d.field}")
    for d in decisions:
        state = session.objects[d.slot]  # type: ignore[index]
        proposal = state.pending.pop(d.field)
        if d.choice == "new":
            state.fields[d.field] = proposal.new
        elif d.choice == "manual":
            state.fields[d.field] = d.manual_text.strip()
        # "old": fields[d.field] already holds the accepted value
