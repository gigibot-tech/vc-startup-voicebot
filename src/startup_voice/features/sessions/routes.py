"""Sessions feature - HTTP routes: list / start / open / delete a conversation.

BUTTON -> BACKEND FLOWS  (browser code: features/sessions/ui/session-list.js + static/app.js)
===========================================================================================

[Neues Gespräch]  (#newBtn, top bar)
    No request to start anything. Only refreshes the list (GET /api/sessions) and shows the picker.

[Neues Gespräch jetzt starten]  (#confirmNewBtn, picker screen)
    app.js startSession()
      -> POST /api/sessions {language}
      -> start_session() below -> InterviewPipeline.start_session()   (no LLM call)
         creates an empty session with the greeting as first assistant message, saves it.
      <- {session, reply: greeting}   the UI opens it.

[Gespräch wählen dropdown / sidebar entry / ?s=<id> in the URL / browser back button]
    app.js openSession(id)
      -> GET /api/sessions/{id}  -> get_session() below -> SessionRegistry.get (cache, else disk)
      <- full session JSON. The UI paints chat + dossier from it.

[Gespräch löschen]  (#deleteBtn, dossier panel)
    app.js deleteBtn handler -> confirm() -> DELETE /api/sessions/{id}
      -> delete_session() below -> drops the cache entry and removes the session folder on disk.
      Then the UI refreshes the list and returns to the picker.

[JSON export link]  (#downloadJson)
    Plain <a href="/api/sessions/{id}">: same endpoint as "open", the browser downloads it.

Also served here (no button; for debugging / API clients): GET /objects/{slot}, GET /steps.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from startup_voice.domain import SLOT_ORDER
from startup_voice.features.sessions.registry import SessionRegistry
from startup_voice.features.sessions.store import evaluate_artifact_file

if TYPE_CHECKING:  # type-only: sessions must not import the interview feature at runtime
    from startup_voice.features.interview.pipeline import InterviewPipeline


class StartBody(BaseModel):
    language: str = "de"


def build_router(*, registry: SessionRegistry, pipeline: InterviewPipeline) -> APIRouter:
    router = APIRouter(prefix="/api/sessions", tags=["sessions"])
    store = registry.store

    @router.get("")
    def list_sessions() -> dict:
        """Sidebar / dropdown data: one small metadata row per saved conversation."""
        return {"sessions": store.list_meta()}

    @router.post("")
    def start_session(body: StartBody | None = None) -> dict:
        """[Neues Gespräch jetzt starten] - create a conversation. Body is optional (old clients)."""
        session, greeting = pipeline.start_session(language=(body.language if body else "de"))
        registry.put(session)
        return {"session": session.model_dump(), "reply": greeting}

    @router.get("/{session_id}")
    def get_session(session_id: str) -> dict:
        """[open conversation] and [JSON export] - the full session document."""
        return registry.get(session_id).model_dump()

    @router.delete("/{session_id}")
    def delete_session(session_id: str) -> dict:
        """[Gespräch löschen] - remove from cache and from disk."""
        registry.drop(session_id)
        try:
            store.delete(session_id)
        except FileNotFoundError as exc:
            raise HTTPException(404, f"Session not found: {session_id}") from exc
        return {"ok": True, "deleted": session_id}

    @router.get("/{session_id}/objects/{slot}")
    def get_object(session_id: str, slot: str) -> dict:
        """Debug: re-score one saved slot file (objects/<slot>.json)."""
        if slot not in SLOT_ORDER:
            raise HTTPException(400, "invalid slot")
        path = store.session_dir(session_id) / "objects" / f"{slot}.json"
        if not path.exists():
            raise HTTPException(404, "object missing")
        return evaluate_artifact_file(path).model_dump() | {"path": str(path)}

    @router.get("/{session_id}/steps")
    def list_steps(session_id: str) -> dict:
        """Debug: names of the per-turn snapshot files."""
        steps_dir = store.session_dir(session_id) / "steps"
        files = sorted(
            p.name for p in steps_dir.glob("turn_*.json") if not p.name.endswith("_eval.json")
        )
        return {"steps": files}

    return router
