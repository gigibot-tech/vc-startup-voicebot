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
from collections import Counter
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
    return v.startswith("transcript so far") or "intake-analyst" in v[:120]


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
    raw_fields: dict[str, Any] = {}
    if isinstance(payload.get("fields"), dict):
        raw_fields.update(payload["fields"])
    # Also accept required field keys placed directly on the slot dict (common LLM flattening).
    for req_key in DIMENSIONS_SPEC[state.slot].required_fields:
        if req_key not in raw_fields and isinstance(payload.get(req_key), str):
            raw_fields[req_key] = payload[req_key]

    wrote_any_field = False
    for key, val in raw_fields.items():
        cleaned = sanitize_field_value(val)
        # Ignore the model echoing the field name itself (e.g. summary="founders_roles").
        if cleaned in DIMENSIONS_SPEC[state.slot].required_fields:
            continue
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
            wrote_any_field = True

    new_summary = ""
    if payload.get("summary"):
        cand = sanitize_field_value(payload["summary"])
        if (
            cand
            and cand not in DIMENSIONS_SPEC[state.slot].required_fields
            and not is_prompt_leak(cand)
            and not (state.summary and is_placeholder_summary(cand))
        ):
            state.summary = cand
            new_summary = cand

    raw_ev = payload.get("evidence")
    ev_items = [raw_ev] if isinstance(raw_ev, str) else (raw_ev if isinstance(raw_ev, list) else [])
    new_ev_added: list[str] = []
    for item in ev_items:
        text = sanitize_field_value(item)
        if (
            text
            and len(text) > 1
            and text not in DIMENSIONS_SPEC[state.slot].required_fields
            and not is_prompt_leak(text)
            and not is_placeholder_summary(text)
            and text not in state.evidence
        ):
            state.evidence.append(text)
            new_ev_added.append(text)

    # Guard against the "93% forever" trap on compound fields (e.g. financing.runway_milestones):
    # When the LLM touches a slot that has ONLY 1 empty field left and writes the founder's
    # answer into `summary` or `evidence` (e.g. "Runway roughly a quarter or more" / "pilot with
    # 20 users") while leaving `fields[last_empty] == ""`, fill that single remaining empty field
    # from `new_summary` or `new_ev_added`.
    req = DIMENSIONS_SPEC[state.slot].required_fields
    still_empty = [f for f in req if not (state.fields.get(f) or "").strip()]
    if not wrote_any_field and len(still_empty) == 1:
        fallback_val = new_summary or (", ".join(new_ev_added) if new_ev_added else "")
        if fallback_val and not is_placeholder_summary(fallback_val):
            propose_field_update(
                state,
                still_empty[0],
                fallback_val[:120],
                source=source,
                turn=turn,
                confidence=0.8,
            )

    state.missing_or_vague = [f for f in req if not (state.fields.get(f) or "").strip()]
    state.updated_at_turn = turn


# Analyst questions often illustrate the answer ("z.B. Beta-Test, 5 Campus-Gruppen").
# Granite copies those examples into the field even when evidence quotes the founder.
_ANALYST_EXAMPLE_MARKERS = (
    "beta-test",
    "beta test",
    "campus-gruppen",
    "campus gruppen",
    "gehälter",
    "gehaelter",
    "entwicklungstools",
)
_FIELD_FOUNDER_HINTS: dict[str, tuple[str, ...]] = {
    "use_of_funds": ("einstell", "person", "gehalt", "mittel"),
    "runway_milestones": ("campus", "uni", "jahresende", "tag", "monat", "launch", "meilen"),
}


def _fold_quote(text: str) -> str:
    return (
        (text or "")
        .casefold()
        .replace("\u2011", "-")
        .replace("‑", "-")
        .replace("–", "-")
    )


def _message_blob(session: InterviewSession, role: str) -> str:
    return _fold_quote("\n".join(m.content for m in session.messages if m.role == role))


def echoes_analyst_example(value: str, founder_blob: str, analyst_blob: str) -> bool:
    """True when the field text is the analyst's example, not the founder's words."""
    folded = _fold_quote(value)
    if not folded or folded in founder_blob:
        return False
    if folded in analyst_blob:
        return True
    return any(
        mark in folded and mark in analyst_blob and mark not in founder_blob
        for mark in _ANALYST_EXAMPLE_MARKERS
    )


def best_founder_evidence(field: str, evidence: Any, founder_blob: str) -> str:
    items = [evidence] if isinstance(evidence, str) else (evidence if isinstance(evidence, list) else [])
    hints = _FIELD_FOUNDER_HINTS.get(field, ())
    best = ""
    best_score = 0
    for item in items:
        text = sanitize_field_value(item)
        folded = _fold_quote(text)
        if not text or folded not in founder_blob:
            continue
        score = sum(1 for hint in hints if hint in folded)
        if score > best_score:
            best, best_score = text, score
    return best[:120]


def ground_extract_in_founder(session: InterviewSession, updates: dict[str, Any]) -> None:
    """Replace analyst-example field values with the founder evidence quote."""
    founder = _message_blob(session, "user")
    analyst = _message_blob(session, "assistant")
    if not founder:
        return
    for payload in updates.values():
        if not isinstance(payload, dict) or not isinstance(payload.get("fields"), dict):
            continue
        evidence = payload.get("evidence") or []
        for key, val in list(payload["fields"].items()):
            cleaned = sanitize_field_value(val)
            if not echoes_analyst_example(cleaned, founder, analyst):
                continue
            quote = best_founder_evidence(key, evidence, founder)
            if quote:
                payload["fields"][key] = quote


# A denial / "nothing" answer a small model (LFM3 1.7B) copies into every field it cannot fill:
# one "Noch keine Nutzer, kein Umsatz." became 'keine' in all of market.* and financing.* and the
# dossier looked 100 % complete. No topic keywords: the check is whether the slot cites a real
# founder quote that itself contains a denial.
_PLACEHOLDER_VALUES = frozenset({
    "keine", "kein", "keiner", "keines", "nein", "nichts", "noch nicht", "keine angabe", "k.a.", "ka",
    "none", "no", "nothing", "not yet", "n/a", "na", "unknown", "unbekannt", "0", "null", "-", "–",
})
_DENIAL_TOKEN_RE = re.compile(r"\b(?:kein\w*|nicht|nein|nichts|none|no|not|nothing|never|null)\b|\b0\b", re.IGNORECASE)


def _placeholder_key(value: Any) -> str:
    return " ".join(str(value or "").strip().strip(".,;:!\"'()").lower().split())


def drop_copied_placeholders(
    session: InterviewSession, updates: dict[str, Any], *, min_copies: int = 3
) -> int:
    """Empty denial placeholders that the extract copied into several fields without evidence.

    When the same placeholder ("keine", "none", "0", …) fills ``min_copies`` or more fields of one
    extract, it is kept only in slots whose ``evidence`` has a quote that (a) occurs in the founder's
    messages and (b) contains a denial word. Everything else is set to "" (= not answered, asked
    again). Returns how many fields were emptied.
    """
    spots: list[tuple[dict[str, Any], str, str]] = []
    for payload in updates.values():
        if not isinstance(payload, dict) or not isinstance(payload.get("fields"), dict):
            continue
        for key, val in payload["fields"].items():
            norm = _placeholder_key(val)
            if norm in _PLACEHOLDER_VALUES:
                spots.append((payload, key, norm))
    counts = Counter(norm for _, _, norm in spots)
    founder = _message_blob(session, "user").lower()
    emptied = 0
    for payload, key, norm in spots:
        if counts[norm] < min_copies:
            continue
        quotes = payload.get("evidence") or []
        quotes = [quotes] if isinstance(quotes, str) else quotes
        grounded = any(
            _placeholder_key(q) and _placeholder_key(q) in " ".join(founder.split())
            and _DENIAL_TOKEN_RE.search(str(q))
            for q in quotes
        )
        if not grounded:
            payload["fields"][key] = ""
            emptied += 1
    return emptied


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
    ground_extract_in_founder(session, updates)
    drop_copied_placeholders(session, updates)
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
