"""ido feature - HTTP routes for running embedded in ido-core (an iframe on an idea's page).

BUTTON -> BACKEND FLOWS  (browser code: features/ido/ui/ido-bridge.js)
=====================================================================

(no button) the dossier changed while embedded in ido-core
    ido-bridge.js -> GET /api/sessions/{id}/ido-delta -> ido_delta() below
      <- {session_id, revision, fields:[{venture_key, value, sources}], notes:[{key, body}]}
    The browser posts what changed to its parent window (postMessage); ido-core writes `fields`
    through apply_venture_field_change and `notes` as cards on the idea's notetaking board. THIS SERVER NEVER SEES A SUPABASE TOKEN and never calls
    ido-core. Not called at all when the app is opened on its own.

(page load, embedded) GET /api/ido/config -> ido_config() below
    <- {origins:[…]}: the ido-core origins this server trusts (IDO_ORIGINS). The browser accepts
       messages only from one of them, and web.py lets only them frame the page (frame-ancestors).
"""

from __future__ import annotations

import os

from fastapi import APIRouter

from startup_voice.features.ido.delta import dossier_to_venture_delta, revision
from startup_voice.features.ido.notes import dossier_to_notes
from startup_voice.features.sessions.registry import SessionRegistry


def allowed_origins() -> list[str]:
    """``IDO_ORIGINS`` = comma-separated origins, e.g. ``http://localhost:3000,https://idoapp.eu``."""
    out: list[str] = []
    for raw in os.getenv("IDO_ORIGINS", "").split(","):
        origin = raw.strip().rstrip("/")
        if origin and origin != "*" and origin not in out:
            out.append(origin)
    return out


def build_router(*, registry: SessionRegistry) -> APIRouter:
    router = APIRouter(tags=["ido"])

    @router.get("/api/ido/config")
    def ido_config() -> dict:
        return {"origins": allowed_origins()}

    @router.get("/api/sessions/{session_id}/ido-delta")
    def ido_delta(session_id: str) -> dict:
        session = registry.get(session_id)
        changes = dossier_to_venture_delta(session)
        notes = dossier_to_notes(session)
        return {
            "session_id": session_id,
            "revision": revision(changes, notes),
            "fields": [c.as_dict() for c in changes],
            "notes": [n.as_dict() for n in notes],
        }

    return router
