"""Dossier as PDF (human-readable labels, Unicode via Noto Sans)."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from fpdf import FPDF
from fpdf.enums import XPos, YPos

from startup_voice.domain import (
    DIMENSIONS_SPEC,
    SLOT_ORDER,
    STATUS_LABELS_DE,
    InterviewSession,
    field_label,
)

_FONTS = Path(__file__).resolve().parent / "fonts"
_FONT_REG = _FONTS / "NotoSans-Regular.ttf"
_FONT_BOLD = _FONTS / "NotoSans-Bold.ttf"


class _DossierPdf(FPDF):
    def footer(self) -> None:
        self.set_y(-14)
        self.set_font("Noto", size=8)
        self.set_text_color(120, 118, 112)
        self.cell(0, 8, f"Seite {self.page_no()}", align="C")


def render_dossier_pdf(session: InterviewSession) -> bytes:
    """Printable dossier with dark header + section blocks (Unicode via Noto Sans)."""
    if not _FONT_REG.is_file() or not _FONT_BOLD.is_file():
        raise FileNotFoundError(f"PDF fonts missing under {_FONTS}")

    pdf = _DossierPdf(format="A4")
    pdf.set_auto_page_break(auto=True, margin=18)
    pdf.add_font("Noto", "", str(_FONT_REG))
    pdf.add_font("Noto", "B", str(_FONT_BOLD))
    pdf.add_page()
    pdf.set_margins(18, 18, 18)

    content_w = pdf.epw  # usable width inside margins
    label_w = 58.0
    value_w = content_w - label_w

    # Header bar
    pdf.set_fill_color(28, 26, 22)
    pdf.rect(0, 0, 210, 34, style="F")
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Noto", "B", 16)
    pdf.set_xy(18, 10)
    pdf.cell(0, 8, "HTGF Startup Erstgespräch", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Noto", size=9)
    pdf.set_x(18)
    pdf.set_text_color(200, 196, 188)
    pdf.cell(0, 6, f"Session {session.id}  ·  {session.created_at}")

    pdf.set_y(42)
    pdf.set_text_color(28, 26, 22)
    pdf.set_font("Noto", "B", 12)
    pdf.cell(0, 8, "Kurzfazit", new_x=XPos.LMARGIN, new_y=YPos.NEXT)
    pdf.set_font("Noto", size=10)
    summary = session.spoken_summary or "Noch keine Zusammenfassung."
    pdf.multi_cell(content_w, 5.5, summary)
    pdf.ln(3)

    for slot in SLOT_ORDER:
        spec = DIMENSIONS_SPEC[slot]
        obj = session.objects[slot]
        status = STATUS_LABELS_DE.get(obj.status, obj.status)

        pdf.set_font("Noto", "B", 11)
        pdf.set_fill_color(240, 238, 235)
        pdf.set_text_color(28, 26, 22)
        pdf.cell(
            content_w,
            8,
            f"{spec.label}  ·  {status}",
            fill=True,
            new_x=XPos.LMARGIN,
            new_y=YPos.NEXT,
        )
        pdf.ln(1)

        if obj.summary:
            pdf.set_font("Noto", size=10)
            pdf.set_text_color(60, 58, 54)
            pdf.multi_cell(content_w, 5, obj.summary)
            pdf.ln(1)

        for key, val in obj.fields.items():
            label = field_label(slot, key)
            text = val or "—"
            y0 = pdf.get_y()
            x0 = pdf.l_margin

            pdf.set_xy(x0, y0)
            pdf.set_font("Noto", "B", 9)
            pdf.set_text_color(28, 26, 22)
            pdf.multi_cell(label_w, 5.5, label)
            y_after_label = pdf.get_y()

            pdf.set_xy(x0 + label_w, y0)
            pdf.set_font("Noto", size=9)
            pdf.set_text_color(50, 48, 44)
            pdf.multi_cell(value_w, 5.5, text)
            y_after_value = pdf.get_y()

            pdf.set_y(max(y_after_label, y_after_value) + 1.5)

        pdf.ln(3)

    out = BytesIO()
    pdf.output(out)
    return out.getvalue()
