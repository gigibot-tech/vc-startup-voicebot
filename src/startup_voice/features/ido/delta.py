"""Dossier -> ido-core venture fields: the pure mapping behind the intake bridge.

The mapping is DATA (journey_map.json, validated against ido-core by docs/ido-journey/validate_map.py),
not code. Only ACCEPTED dossier values are read: a value still waiting in the review gate lives in
``DimensionState.pending`` and is never part of the delta. This module decides WHAT would be written;
whether a write is allowed (founder-edited values are not overwritten) is decided on the ido-core
side, next to the data, in src/lib/intake-bridge/applyDelta.ts.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from startup_voice.domain import InterviewSession, field_label

_MAP_PATH = Path(__file__).with_name("journey_map.json")


@lru_cache(maxsize=1)
def load_map() -> dict:
    return json.loads(_MAP_PATH.read_text(encoding="utf-8"))


@dataclass(frozen=True)
class VentureChange:
    venture_key: str
    value: str
    sources: tuple[str, ...]

    def as_dict(self) -> dict:
        return {"venture_key": self.venture_key, "value": self.value, "sources": list(self.sources)}


def dossier_to_venture_delta(session: InterviewSession) -> list[VentureChange]:
    """Everything the dossier currently knows, expressed as venture field values.

    ``compose`` keys (team, traction, funding) join their filled sub-fields as labelled lines so a
    reader in ido-core sees which part is which; ``direct`` keys carry the single value as it is.
    Empty dossier fields produce nothing: the intake never blanks a venture field.
    """
    changes: list[VentureChange] = []
    for entry in load_map()["venture_map"]:
        filled: list[tuple[str, str, str]] = []
        for src in entry["sources"]:
            slot, field = src.split(".", 1)
            state = session.objects.get(slot)
            value = ((state.fields.get(field) if state else "") or "").strip()
            if value:
                filled.append((src, field_label(slot, field), value))  # type: ignore[arg-type]
        if not filled:
            continue
        if entry["mode"] == "compose":
            text = "\n".join(f"{label}: {value}" for _, label, value in filled)
        else:
            text = filled[0][2]
        changes.append(VentureChange(entry["venture_key"], text, tuple(src for src, _, _ in filled)))
    return changes


def revision(changes: list[VentureChange], notes: list | None = None) -> str:
    """Stable fingerprint: the browser re-sends only when this changes."""
    payload = [c.as_dict() for c in changes] + [n.as_dict() for n in (notes or [])]
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:12]
