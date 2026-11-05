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
        Appends to ``session.conflict_history`` (expandable UI).

Because every writer goes through here, "what is in the dossier" is always a value a human
either saw or never had to decide on (empty -> filled). Open proposals do not count for scoring.

``REVIEW_SOURCES`` is the policy knob: a source listed here asks for review on conflicts,
a source NOT listed overwrites silently (the old behaviour).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

from startup_voice.domain import (
    DIMENSIONS_SPEC,
    SLOT_ORDER,
    ConflictResolution,
    DimensionState,
    FieldProposal,
    InterviewSession,
    SlotId,
)
from startup_voice.features.dossier.scoring import apply_belege_map

REVIEW_SOURCES = ("chat", "tool", "pdf")  # matched on the part before ":" ("pdf:<doc_id>" -> "pdf")

Choice = Literal["old", "new", "manual"]


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip()).casefold()


def _clamp_conf(value: Any, fallback: float = 0.5) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return max(0.0, min(1.0, float(fallback)))


_NULLISH_RE = re.compile(r"^(null|none|n/?a|nil|undefined|-|—|–)$", re.IGNORECASE)
_NOT_MENTIONED_SUMMARY_RE = re.compile(
    r"\b(nicht\s+genannt|not\s+mentioned|keine\s+angabe|unbekannt)\b",
    re.IGNORECASE,
)


def is_prompt_leak(val: str) -> bool:
    """Drop values that are clearly the model echoing the system/transcript prompt."""
    v = val.strip().lower()
    return v.startswith("transcript so far") or "htgf-intake-analyst" in v[:120]


def is_placeholder_summary(val: str) -> bool:
    """Reject 'Team nicht genannt' style summaries that wipe good prior summaries."""
    return bool(_NOT_MENTIONED_SUMMARY_RE.search(val or ""))


def sanitize_field_value(val: Any) -> str:
    """Normalize extract field text; treat nullish tokens as empty (do not store)."""
    cleaned = str(val if val is not None else "").strip()
    if not cleaned or _NULLISH_RE.match(cleaned):
        return ""
    return cleaned


def propose_field_update(
    state: DimensionState,
    field: str,
    new: str,
    *,
    source: str,
    turn: int,
    quote: str = "",
    page: int | None = None,
    confidence: float | None = None,
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
    conf = _clamp_conf(
        confidence if confidence is not None else (existing.confidence if existing else 0.5)
    )
    state.pending[field] = FieldProposal(
        old=existing.old if existing else old,  # keep the first "before" when proposals stack up
        new=new,
        source=source,
        quote=quote,
        page=page,
        turn=turn,
        confidence=conf,
    )
    return "pending"


def merge_slot_update(
    state: DimensionState,
    payload: dict[str, Any],
    *,
    turn: int,
    source: str = "chat",
) -> None:
    """Apply one extract/tool slot payload through the review gate (+ summary/evidence)."""
    conf_map = payload.get("confidence") if isinstance(payload.get("confidence"), dict) else {}
    for key, val in (payload.get("fields") or {}).items():
        cleaned = sanitize_field_value(val)
        if key in state.fields and cleaned and not is_prompt_leak(cleaned):
            raw_c = conf_map.get(key) if conf_map else None
            propose_field_update(
                state,
                key,
                cleaned,
                source=source,
                turn=turn,
                confidence=_clamp_conf(raw_c) if raw_c is not None else None,
            )
    if payload.get("summary"):
        summary = sanitize_field_value(payload["summary"])
        if summary and not is_prompt_leak(summary) and not (
            state.summary and is_placeholder_summary(summary)
        ):
            state.summary = summary
    raw_ev = payload.get("evidence")
    ev_items = [raw_ev] if isinstance(raw_ev, str) else (raw_ev if isinstance(raw_ev, list) else [])
    for item in ev_items:
        text = sanitize_field_value(item)
        if text and len(text) > 1 and not is_prompt_leak(text) and text not in state.evidence:
            state.evidence.append(text)
    req = DIMENSIONS_SPEC[state.slot].required_fields
    state.missing_or_vague = [f for f in req if not (state.fields.get(f) or "").strip()]
    state.updated_at_turn = turn


def apply_extract_updates(
    session: InterviewSession,
    updates: dict[str, Any],
    belege: dict[str, Any] | None,
    *,
    turn: int,
    source: str = "chat",
) -> list[SlotId]:
    """Postprocess extract: merge touched slots + apply belege map. Returns touched slot ids."""
    touched: list[SlotId] = []
    for slot in SLOT_ORDER:
        if slot not in updates:
            continue
        merge_slot_update(session.objects[slot], updates[slot] or {}, turn=turn, source=source)
        touched.append(slot)
    apply_belege_map(session, belege or {})
    # Backfill pending confidence from slot belege when extract omitted field confidence.
    for slot in touched:
        state = session.objects[slot]
        slot_belege = float(state.belege or 0.0)
        for field, prop in state.pending.items():
            if prop.confidence == 0.5 and slot_belege > 0:
                state.pending[field] = prop.model_copy(update={"confidence": _clamp_conf(slot_belege)})
    return touched


@dataclass(frozen=True)
class Decision:
    slot: str
    field: str
    choice: Choice
    manual_text: str = ""
    auto: bool = False


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
        session.conflict_history.append(
            ConflictResolution(
                slot=d.slot,
                field=d.field,
                choice=d.choice,
                old=proposal.old,
                new=proposal.new if d.choice != "manual" else d.manual_text.strip(),
                confidence=proposal.confidence,
                source=proposal.source,
                auto=bool(d.auto),
            )
        )
