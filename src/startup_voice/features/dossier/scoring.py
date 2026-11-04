"""Deterministic scoring of slots and sessions (pure logic, no I/O, no LLM)."""

from __future__ import annotations

import re

from startup_voice.domain import (
    DIMENSIONS_SPEC,
    SLOT_ORDER,
    DimensionState,
    InterviewSession,
    SlotId,
    SlotStatus,
    StepEvaluation,
)

_SPECIFIC = re.compile(
    r"\d|%|€|\$|mrr|arr|mvp|pilot|loi|seed|pre-?seed|kund|user|umsat|"
    r"kein|keine|keiner|nein|none|null|n/?a|verneint|zero",
    re.I,
)


def evaluate_dimension(state: DimensionState) -> tuple[float, float, SlotStatus, list[str]]:
    spec = DIMENSIONS_SPEC[state.slot]
    missing = [f for f in spec.required_fields if not (state.fields.get(f) or "").strip()]
    filled = len(spec.required_fields) - len(missing)
    coverage = filled / max(1, len(spec.required_fields))
    blob = " ".join([state.summary, *state.evidence, *state.fields.values()])
    hits = len(_SPECIFIC.findall(blob))
    specificity = min(1.0, hits / 3.0) if blob.strip() else 0.0
    # Explicit zeros/denials are enough to close a well-covered slot.
    if coverage >= 0.67 and specificity >= 0.34 and not state.missing_or_vague:
        status: SlotStatus = "solid"
    elif coverage > 0 or state.evidence or state.summary:
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
    # 1) Never touched — get something written into every dimension.
    for slot in SLOT_ORDER:
        if coverages.get(slot, 0) <= 0 and statuses.get(slot) != "solid":
            return slot
    # 2) Fields still missing inside a slot.
    for slot in SLOT_ORDER:
        if coverages.get(slot, 0) < 1.0:
            return slot
    # 3) All fields set somewhere — deepen weak / non-solid slots.
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
