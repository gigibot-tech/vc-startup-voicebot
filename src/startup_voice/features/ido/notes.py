"""Dossier -> note cards for the idea's notetaking board in ido-core.

One card per dossier area (team, product, traction, market, financing), only for areas that have
content. This module only produces the BODY of each card; ido-core owns the title, the footer
checksum and the rule about not touching cards a founder edited (src/lib/intake-bridge/notes.ts),
so nothing sent from here can choose a title or impersonate a founder's own note.

Never included: the conversation, evidence quotes, scores. Only accepted dossier values, as labelled
lines, in the dossier's own labels.
"""

from __future__ import annotations

from dataclasses import dataclass

from startup_voice.domain import DIMENSIONS_SPEC, SLOT_ORDER, InterviewSession, field_label


@dataclass(frozen=True)
class NoteCard:
    key: str  # a dossier slot id: team | product | traction | market | financing
    body: str

    def as_dict(self) -> dict:
        return {"key": self.key, "body": self.body}


def dossier_to_notes(session: InterviewSession) -> list[NoteCard]:
    cards: list[NoteCard] = []
    for slot in SLOT_ORDER:
        state = session.objects.get(slot)
        if state is None:
            continue
        lines = []
        for field in DIMENSIONS_SPEC[slot].required_fields:
            value = (state.fields.get(field) or "").strip()
            if value:
                lines.append(f"{field_label(slot, field)}: {value}")
        if lines:
            cards.append(NoteCard(slot, "\n".join(lines)))
    return cards
