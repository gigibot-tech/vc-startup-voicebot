"""Dossier feature - HTTP routes: schema labels, exports, clear.

BUTTON -> BACKEND FLOWS  (browser code: features/dossier/ui/render.js + actions.js)
===================================================================================

(on page load)  dossier-schema.js loadDossierSchema()
    -> GET /api/dossier-schema -> dossier_schema() below -> domain.dossier_schema_public()
    Human-readable slot/field labels, so the UI never shows snake_case keys.

[Markdown]  (#downloadMd)   plain link  GET /api/sessions/{id}/dossier.md
    -> dossier_md() below -> render_dossier_markdown(); also writes dossier.md next to the session.
[PDF]       (#downloadPdf)  plain link  GET /api/sessions/{id}/dossier.pdf
    -> dossier_pdf() below -> render_dossier_pdf() (fpdf2 + bundled NotoSans fonts).
    Both are downloads built from the SAVED session on disk, not from the browser's copy.

[Dossier leeren]  (#clearBtn)
    actions.js -> confirm() -> POST /api/sessions/{id}/clear
    -> clear_dossier() below -> InterviewPipeline.clear_dossier(): blank all slots, un-finalize,
       re-score, save. The chat messages stay. No LLM call.

[Speichern] on a proposal card  (dossier/ui/proposals.js)
    -> POST /api/sessions/{id}/dossier/resolve {decisions:[{slot, field, choice, manual_text}]}
    -> resolve_dossier() below -> InterviewPipeline.resolve_proposals(): for each open LLM
       suggestion keep the OLD value, take the NEW one, or take the human's MANUAL text
       (rejected with 400 if empty). All-or-nothing, re-scores, saves. No LLM call.
    Proposals are created by features/dossier/review.py when an extraction would overwrite a
    filled field.

[JSON]  (#downloadJson) is served by the sessions feature (GET /api/sessions/{id}).
[Dossier abschließen] is served by the interview feature (it needs the LLM).

Also: POST /api/evaluate-file (no button) re-scores any artifact JSON file on disk.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse, Response
from pydantic import BaseModel, Field

from startup_voice.domain import dossier_schema_public
from startup_voice.features.dossier.review import Choice, Decision
from startup_voice.features.dossier import render_dossier_markdown, render_dossier_pdf
from startup_voice.features.sessions.registry import SessionRegistry
from startup_voice.features.sessions.store import evaluate_artifact_file

if TYPE_CHECKING:  # type-only: dossier must not import the interview feature at runtime
    from startup_voice.features.interview.pipeline import InterviewPipeline


class DecisionBody(BaseModel):
    slot: str
    field: str
    choice: Choice
    manual_text: str = ""


class ResolveBody(BaseModel):
    decisions: list[DecisionBody] = Field(min_length=1)


class EvaluateBody(BaseModel):
    path: str = Field(min_length=1)


def build_router(*, registry: SessionRegistry, pipeline: InterviewPipeline) -> APIRouter:
    router = APIRouter(tags=["dossier"])
    store = registry.store

    @router.get("/api/dossier-schema")
    def dossier_schema() -> dict:
        """Human labels for UI (no snake_case keys as display text)."""
        return dossier_schema_public()

    @router.post("/api/sessions/{session_id}/clear")
    def clear_dossier(session_id: str) -> dict:
        """[Dossier leeren] - wipe slot fields, keep the chat."""
        session = pipeline.clear_dossier(registry.get(session_id))
        registry.put(session)
        return {"session": session.model_dump()}

    @router.post("/api/sessions/{session_id}/dossier/resolve")
    def resolve_dossier(session_id: str, body: ResolveBody) -> dict:
        """[Speichern] on proposal cards - apply old/new/manual choices."""
        session = registry.get(session_id)
        decisions = [Decision(d.slot, d.field, d.choice, d.manual_text) for d in body.decisions]
        try:
            session = pipeline.resolve_proposals(session, decisions)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        registry.put(session)
        return {"session": session.model_dump()}

    @router.get("/api/sessions/{session_id}/dossier.md")
    def dossier_md(session_id: str) -> PlainTextResponse:
        """[Markdown] download."""
        try:
            session = store.load(session_id)
        except FileNotFoundError:
            raise HTTPException(404, "session missing") from None
        md = render_dossier_markdown(session)
        path = store.session_dir(session_id) / "dossier.md"
        path.write_text(md, encoding="utf-8")
        return PlainTextResponse(
            md,
            media_type="text/markdown; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="dossier-{session_id}.md"'},
        )

    @router.get("/api/sessions/{session_id}/dossier.pdf")
    def dossier_pdf(session_id: str) -> Response:
        """[PDF] download."""
        try:
            session = store.load(session_id)
        except FileNotFoundError:
            raise HTTPException(404, "session missing") from None
        try:
            pdf_bytes = render_dossier_pdf(session)
        except FileNotFoundError as exc:
            raise HTTPException(500, str(exc)) from exc
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="dossier-{session_id}.pdf"'},
        )

    @router.post("/api/evaluate-file")
    def evaluate_file(body: EvaluateBody) -> dict:
        path = Path(body.path)
        if not path.is_file():
            raise HTTPException(404, "file not found")
        return evaluate_artifact_file(path).model_dump()

    return router
