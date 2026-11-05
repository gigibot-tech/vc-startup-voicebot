"""SSOT domain models for the 5 intake objects, steps, and evaluation."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal, Protocol
from uuid import uuid4

from pydantic import BaseModel, Field

SlotId = Literal["team", "product", "traction", "market", "financing"]
SlotStatus = Literal["open", "partial", "solid"]


class ObjectSlotSpec(BaseModel):
    """Declarative schema for one intake object (SSOT for extract + evaluate)."""

    id: SlotId
    label: str
    description: str
    required_fields: list[str]
    field_labels: dict[str, str] = Field(default_factory=dict)
    prompt_hints: list[str] = Field(default_factory=list)


DIMENSIONS_SPEC: dict[SlotId, ObjectSlotSpec] = {
    "team": ObjectSlotSpec(
        id="team",
        label="Team",
        description="Founders, roles, expertise, and commitment.",
        required_fields=["founders_roles", "background_expertise", "commitment_fulltime"],
        field_labels={
            "founders_roles": "Gründer & Rollen",
            "background_expertise": "Hintergrund & Expertise",
            "commitment_fulltime": "Zeitliche Verfügbarkeit",
        },
        prompt_hints=["founders & roles", "domain expertise", "full-time commitment"],
    ),
    "product": ObjectSlotSpec(
        id="product",
        label="Produkt & Stand",
        description="Problem, solution, development stage, USP.",
        required_fields=["problem_solution", "stage_status", "usp_tech"],
        field_labels={
            "problem_solution": "Problem & Lösung",
            "stage_status": "Entwicklungsstand",
            "usp_tech": "Alleinstellung & Tech",
        },
        prompt_hints=["problem & solution", "idea/prototype/MVP/live", "USP / tech"],
    ),
    "traction": ObjectSlotSpec(
        id="traction",
        label="Traktion",
        description="Customers, pilots, revenue, growth metrics.",
        required_fields=["customers_pilots", "metrics_revenue", "growth_signal"],
        field_labels={
            "customers_pilots": "Kunden & Piloten",
            "metrics_revenue": "Umsatz & Kennzahlen",
            "growth_signal": "Wachstumssignal",
        },
        prompt_hints=["customers / pilots / LOIs", "MRR/ARR / numbers", "growth"],
    ),
    "market": ObjectSlotSpec(
        id="market",
        label="Markt & Wettbewerb",
        description="ICP, market size, competitors, moat.",
        required_fields=["target_icp", "market_size", "competitors_moat"],
        field_labels={
            "target_icp": "Zielgruppe",
            "market_size": "Marktgröße",
            "competitors_moat": "Wettbewerb & Vorsprung",
        },
        prompt_hints=["target ICP", "market size", "competitors & moat"],
    ),
    "financing": ObjectSlotSpec(
        id="financing",
        label="Finanzierung",
        description="Raise amount, round, use of funds, runway.",
        required_fields=["raise_amount_round", "use_of_funds", "runway_milestones"],
        field_labels={
            "raise_amount_round": "Finanzierungsrunde",
            "use_of_funds": "Mittelverwendung",
            "runway_milestones": "Runway & Meilensteine",
        },
        prompt_hints=["amount & round", "use of funds", "runway / milestones"],
    ),
}

SLOT_ORDER: tuple[SlotId, ...] = ("team", "product", "traction", "market", "financing")

STATUS_LABELS_DE: dict[str, str] = {
    "open": "Offen",
    "partial": "In Arbeit",
    "solid": "Belastbar",
}
STATUS_LABELS_EN: dict[str, str] = {
    "open": "Open",
    "partial": "In progress",
    "solid": "Solid",
}
STATUS_LABELS = STATUS_LABELS_DE


def field_label(slot: SlotId, key: str) -> str:
    return DIMENSIONS_SPEC[slot].field_labels.get(key, key.replace("_", " ").title())


def empty_fields(slot: SlotId) -> dict[str, str]:
    return {name: "" for name in DIMENSIONS_SPEC[slot].required_fields}


def dossier_schema_public() -> dict:
    """UI-facing labels (no internal keys as display text)."""
    return {
        "slots": [
            {
                "id": slot,
                "label": DIMENSIONS_SPEC[slot].label,
                "fields": [
                    {"id": f, "label": field_label(slot, f)}
                    for f in DIMENSIONS_SPEC[slot].required_fields
                ],
            }
            for slot in SLOT_ORDER
        ],
        "status_labels": STATUS_LABELS,
    }


class FieldProposal(BaseModel):
    """A LLM suggestion that would OVERWRITE an already filled dossier field.

    It waits here until a human picks old / new / manual (see features/dossier/review.py).
    Scoring only ever reads ``DimensionState.fields`` (the accepted value), never this.
    ``confidence`` (0–1) drives client auto-resolve when above the user threshold.
    """

    old: str  # accepted value when the first proposal for this field arrived
    new: str  # latest LLM suggestion
    source: str = "chat"  # "chat" | "tool" | "pdf:<doc_id>"
    quote: str = ""  # evidence for the suggestion (mandatory for pdf sources)
    page: int | None = None
    turn: int = 0
    confidence: float = 0.5  # extract LLM (or belege fallback); used for auto-resolve


class ConflictResolution(BaseModel):
    """One resolved merge conflict (auto or manual) for the expandable history UI."""

    slot: str
    field: str
    choice: Literal["old", "new", "manual"]
    old: str = ""
    new: str = ""
    confidence: float = 0.0
    source: str = "chat"
    at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    auto: bool = False


class DimensionState(BaseModel):
    """One filled intake object with evidence and evaluation hooks."""

    slot: SlotId
    fields: dict[str, str] = Field(default_factory=dict)
    pending: dict[str, FieldProposal] = Field(default_factory=dict)  # field name -> open proposal
    summary: str = ""
    evidence: list[str] = Field(default_factory=list)
    missing_or_vague: list[str] = Field(default_factory=list)
    status: SlotStatus = "open"
    # LLM-judged Belege quality 0..1 (concreteness / readability for HTGF). Not keyword hits.
    belege: float = 0.0
    updated_at_turn: int = 0

    @classmethod
    def blank(cls, slot: SlotId) -> DimensionState:
        return cls(slot=slot, fields=empty_fields(slot))


class StepEvaluation(BaseModel):
    """Session score: coverage is field-fill ratio; specificity/Belege comes from LLM ``belege``."""

    field_coverage: float = 0.0
    evidence_specificity: float = 0.0
    status: SlotStatus = "open"
    missing_fields: list[str] = Field(default_factory=list)
    next_focus_slot: SlotId | None = None
    ready_for_closing: bool = False
    slot_coverage: dict[str, float] = Field(default_factory=dict)
    slot_specificity: dict[str, float] = Field(default_factory=dict)


class TurnMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str
    ts: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    warning: str = ""  # embedded inline warning in AI bubble when token/context limit hit


class StepSnapshot(BaseModel):
    """Immutable checkpoint after one turn / tool update."""

    turn_index: int
    user_input: str
    updated_slots: list[SlotId] = Field(default_factory=list)
    objects_state: dict[SlotId, DimensionState]
    step_eval: StepEvaluation
    agent_reply: str


class DossierVersion(BaseModel):
    """Immutable finalized dossier snapshot on disk (one session can have v1, v2, …)."""

    version: int
    id: str  # e.g. "v01_20261105T144800Z"
    created_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    turn_index: int = 0
    field_coverage: float = 0.0
    evidence_specificity: float = 0.0
    ready_for_closing: bool = False
    spoken_summary: str = ""


class InterviewSession(BaseModel):
    id: str = Field(default_factory=lambda: uuid4().hex[:12])
    created_at: str = Field(default_factory=lambda: datetime.now(UTC).isoformat())
    language: str = "de"
    # Per-session Nachhaken mode (balanced|insist|strict). Default = Ausgewogen.
    followup_mode: str = "balanced"
    objects: dict[SlotId, DimensionState] = Field(default_factory=dict)
    messages: list[TurnMessage] = Field(default_factory=list)
    turn_index: int = 0
    finalized: bool = False
    spoken_summary: str = ""
    evaluation: StepEvaluation = Field(default_factory=StepEvaluation)
    conflict_history: list[ConflictResolution] = Field(default_factory=list)
    dossier_versions: list[DossierVersion] = Field(default_factory=list)

    @classmethod
    def create(cls, *, language: str = "de", followup_mode: str = "balanced") -> InterviewSession:
        objects = {slot: DimensionState.blank(slot) for slot in SLOT_ORDER}
        return cls(language=language, followup_mode=followup_mode, objects=objects)


class LLM(Protocol):
    def complete(
        self,
        system: str,
        user: str,
        *,
        max_tokens: int | None = None,
        json_mode: bool = False,
    ) -> str: ...
