"""Board feature - HTTP routes for publishing a dossier and for the public pages.

BUTTON -> BACKEND FLOWS  (browser code: features/board/ui/publish.js and the two public pages)
=============================================================================================

[Öffentlich teilen…]  (#publishBtn in the dossier panel)
    publish.js -> GET  /api/sessions/{id}/publish-preview   -> publish_preview() below
                  <- {sections: {product,traction,market,financing}, existing}  (default texts)
               -> POST /api/sessions/{id}/publish          -> publish() below
                  body {title, sections, listed, consent, listing_consent, consent_version,
                        email, email_consent, owner_key}
                  <- {slug, path, owner_key|null}   owner_key is returned ONCE, on creation.
    Nothing is public before this call; team is never accepted.

(public, no login)  /board  -> GET /api/public/board        listed dossiers only
                    /d/{slug} -> GET /api/public/{slug}     one published dossier, 404 once withdrawn
                    [Melden]  -> POST /api/public/{slug}/report
                    [Zurückziehen] (needs the owner key) -> POST /api/public/{slug}/withdraw

These routes never call the LLM and never store IP addresses. Rate limits live in memory only.
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from startup_voice.features.board.store import (
    CONSENT_VERSION,
    MAX_REPORT,
    PUBLISHABLE,
    SLUG_RE,
    BoardStore,
    OwnerKeyError,
    PublishError,
    RateLimiter,
)
from startup_voice.features.ido.notes import dossier_to_notes
from startup_voice.features.sessions.registry import SessionRegistry

_UI = Path(__file__).parent / "ui"


class PublishBody(BaseModel):
    title: str = Field(default="", max_length=200)
    sections: dict = Field(default_factory=dict)
    listed: bool = False
    consent: bool = False
    listing_consent: bool = False
    consent_version: str = Field(default="", max_length=64)
    email: str | None = Field(default=None, max_length=300)
    email_consent: bool = False
    owner_key: str | None = Field(default=None, max_length=200)


class WithdrawBody(BaseModel):
    owner_key: str = Field(default="", max_length=200)


class ReportBody(BaseModel):
    reason: str = Field(default="", max_length=MAX_REPORT)


def _who(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def build_router(*, registry: SessionRegistry) -> APIRouter:
    router = APIRouter(tags=["board"])
    store = BoardStore(registry.store.root)
    publish_limit = RateLimiter(limit=10, window_s=3600)
    report_limit = RateLimiter(limit=5, window_s=3600)
    page_headers = {"Cache-Control": "no-store"}

    # -- publishing (from inside the app) -------------------------------------------------------
    @router.get("/api/sessions/{session_id}/publish-preview")
    def publish_preview(session_id: str) -> dict:
        session = registry.get(session_id)
        bodies = {c.key: c.body for c in dossier_to_notes(session) if c.key in PUBLISHABLE}
        rec = store.for_session(session_id)
        existing = None
        if rec is not None:
            existing = {
                "slug": rec["slug"],
                "published": not rec.get("unpublished_at"),
                "listed": bool(rec.get("listed")),
                "title": rec.get("title", ""),
            }
        return {"sections": bodies, "existing": existing, "consent_version": CONSENT_VERSION}

    @router.post("/api/sessions/{session_id}/publish")
    def publish(session_id: str, body: PublishBody, request: Request) -> dict:
        registry.get(session_id)  # 404 for an unknown session
        if not publish_limit.allow(_who(request)):
            raise HTTPException(429, "Too many publications. Try again later.")
        try:
            result = store.publish(
                session_id=session_id,
                title=body.title,
                sections=body.sections,
                listed=body.listed,
                consent=body.consent,
                listing_consent=body.listing_consent,
                consent_version=body.consent_version,
                email=body.email,
                email_consent=body.email_consent,
                owner_key=body.owner_key,
            )
        except OwnerKeyError as exc:
            raise HTTPException(403, str(exc)) from exc
        except PublishError as exc:
            raise HTTPException(422, str(exc)) from exc
        return {"slug": result.slug, "path": f"/d/{result.slug}", "owner_key": result.owner_key}

    # -- public data ----------------------------------------------------------------------------
    @router.get("/api/public/board")
    def board() -> dict:
        return {"items": store.listed(), "cta_url": os.getenv("IDO_APP_URL", "https://idoapp.eu")}

    @router.get("/api/public/{slug}")
    def public_dossier(slug: str) -> dict:
        view = store.public_view(slug) if SLUG_RE.match(slug) else None
        if view is None:
            raise HTTPException(404, "Not found")
        return {**view, "cta_url": os.getenv("IDO_APP_URL", "https://idoapp.eu")}

    @router.post("/api/public/{slug}/withdraw")
    def withdraw(slug: str, body: WithdrawBody, request: Request) -> dict:
        if not publish_limit.allow(_who(request)):
            raise HTTPException(429, "Too many attempts. Try again later.")
        try:
            done = store.withdraw(slug, body.owner_key) if SLUG_RE.match(slug) else False
        except OwnerKeyError as exc:
            raise HTTPException(403, str(exc)) from exc
        if not done:
            raise HTTPException(404, "Not found")
        return {"ok": True}

    @router.post("/api/public/{slug}/report")
    def report(slug: str, body: ReportBody, request: Request) -> dict:
        if not report_limit.allow(_who(request)):
            raise HTTPException(429, "Too many reports. Try again later.")
        if not SLUG_RE.match(slug) or not store.report(slug, body.reason.strip() or "(no reason given)"):
            raise HTTPException(404, "Not found")
        return {"ok": True}

    # -- the two public pages -------------------------------------------------------------------
    @router.get("/board")
    def board_page() -> FileResponse:
        return FileResponse(_UI / "board.html", headers=page_headers)

    @router.get("/d/{slug}")
    def dossier_page(slug: str) -> FileResponse:
        if not SLUG_RE.match(slug):
            raise HTTPException(404, "Not found")
        return FileResponse(_UI / "dossier.html", headers=page_headers)

    return router
