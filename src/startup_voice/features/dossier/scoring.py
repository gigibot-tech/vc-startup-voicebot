"""Slot/session status from field coverage + LLM Belege scores (no keyword heuristics).

Coverage = share of required fields filled (deterministic).
Specificity / „Belege %“ = ``DimensionState.belege`` written by the interview LLM
(extract or refresh) — how concrete and readable the evidence is for an HTGF analyst.

Call ``refresh_evaluation(session)`` once after dossier mutations (extract / resolve /
tool / clear). Persistence just writes ``session.evaluation`` — it does not re-score.
"""

from __future__ import annotations

from typing import Any

from startup_voice.domain import (
    DIMENSIONS_SPEC,
    SLOT_ORDER,
    DimensionState,
    InterviewSession,
    SlotId,
    SlotStatus,
    StepEvaluation,
)


def clamp_belege(value: float | int | str | None) -> float:
    try:
        n = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    if n != n:  # NaN
        return 0.0
    return max(0.0, min(1.0, n))


def slot_has_content(state: DimensionState) -> bool:
    return bool(
        any((v or "").strip() for v in state.fields.values())
        or (state.summary or "").strip()
        or state.evidence
    )


def apply_belege_map(session: InterviewSession, belege: Any) -> None:
    """Write LLM belege 0..1 onto matching slots (never downgrade a filled slot to 0)."""
    if not isinstance(belege, dict):
        return
    for slot in SLOT_ORDER:
        if slot not in belege:
            continue
        state = session.objects[slot]
        val = clamp_belege(belege[slot])
        # Extract often emits 0 for slots not mentioned this turn — keep prior belege if slot has content.
        if val <= 0 and slot_has_content(state) and float(state.belege or 0) > 0:
            continue
        state.belege = val


def evaluate_dimension(state: DimensionState) -> tuple[float, float, SlotStatus, list[str]]:
    spec = DIMENSIONS_SPEC[state.slot]
    missing = [f for f in spec.required_fields if not (state.fields.get(f) or "").strip()]
    filled = len(spec.required_fields) - len(missing)
    coverage = filled / max(1, len(spec.required_fields))
    has_content = slot_has_content(state)
    raw_spec = clamp_belege(state.belege) if has_content else 0.0
    # Full field coverage with no missing_or_vague guarantees a baseline specificity so a missed
    # belege score never blocks ready_for_closing when all 3 fields are concretely filled.
    specificity = max(raw_spec, 0.5) if (coverage >= 1.0 and not missing) else raw_spec
    if coverage >= 0.67 and specificity >= 0.34 and not state.missing_or_vague:
        status: SlotStatus = "solid"
    elif has_content:
        status = "partial"
    else:
        status = "open"
    return coverage, specificity, status, missing


def pick_next_focus(
    *,
    coverages: dict[str, float],
    statuses: dict[str, SlotStatus],
) -> SlotId | None:
    """Breadth-first: empty slots first, then incomplete fields, then quality deepen."""
    for slot in SLOT_ORDER:
        if coverages.get(slot, 0) <= 0 and statuses.get(slot) != "solid":
            return slot
    for slot in SLOT_ORDER:
        if coverages.get(slot, 0) < 1.0:
            return slot
    for slot in SLOT_ORDER:
        if statuses.get(slot) != "solid":
            return slot
    return None


def evaluate_session(session: InterviewSession) -> StepEvaluation:
    coverages: dict[str, float] = {}
    specificities: dict[str, float] = {}
    statuses: dict[str, SlotStatus] = {}
    missing: list[str] = []
    specs: list[float] = []
    for slot in SLOT_ORDER:
        state = session.objects[slot]
        cov, spec, status, miss = evaluate_dimension(state)
        state.status = status
        coverages[slot] = round(cov, 3)
        specificities[slot] = round(spec, 3)
        statuses[slot] = status
        specs.append(spec)
        for field in miss:
            missing.append(f"{slot}.{field}")
    avg_cov = sum(coverages.values()) / len(SLOT_ORDER)
    avg_spec = sum(specs) / len(specs) if specs else 0.0
    ready = all(statuses[s] == "solid" for s in SLOT_ORDER)
    next_slot = None if ready else pick_next_focus(coverages=coverages, statuses=statuses)
    return StepEvaluation(
        field_coverage=round(avg_cov, 3),
        evidence_specificity=round(avg_spec, 3),
        status="solid" if ready else ("partial" if avg_cov > 0 else "open"),
        missing_fields=missing,
        next_focus_slot=next_slot,
        ready_for_closing=ready,
        slot_coverage=coverages,
        slot_specificity=specificities,
    )


def refresh_evaluation(session: InterviewSession) -> StepEvaluation:
    """Single write path for ``session.evaluation`` after dossier mutations."""
    session.evaluation = evaluate_session(session)
    return session.evaluation
