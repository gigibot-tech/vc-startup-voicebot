"""Dossier as Markdown (no PDF dependency)."""

from __future__ import annotations

from startup_voice.domain import (
    DIMENSIONS_SPEC,
    SLOT_ORDER,
    STATUS_LABELS_DE,
    InterviewSession,
    field_label,
)


def render_dossier_markdown(session: InterviewSession) -> str:
    lines = [
        "# HTGF Startup Erstgespräch",
        "",
        f"_Session `{session.id}` · {session.created_at}_",
        "",
        "## Kurzfazit",
        "",
        session.spoken_summary or "_Noch keine Zusammenfassung._",
        "",
        "## Dimensionen",
        "",
    ]
    for slot in SLOT_ORDER:
        spec = DIMENSIONS_SPEC[slot]
        obj = session.objects[slot]
        status = STATUS_LABELS_DE.get(obj.status, obj.status)
        lines.append(f"### {spec.label} — {status}")
        lines.append("")
        if obj.summary:
            lines.append(obj.summary)
            lines.append("")
        for key, val in obj.fields.items():
            label = field_label(slot, key)
            lines.append(f"- **{label}:** {val or '—'}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
