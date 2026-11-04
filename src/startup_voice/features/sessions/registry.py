"""In-memory session cache in front of the on-disk store, shared by every feature's routes.

Why it exists
-------------
Several features (interview turns, dossier clear, session CRUD) need "give me session X".
Instead of each router re-implementing load-from-disk + cache, they all receive ONE
``SessionRegistry`` instance (created in web.create_app).

    get(id)  -> cached session, else loaded from disk (and cached), else HTTP 404
    put(s)   -> remember the (mutated) session object so the next request sees it
    drop(id) -> forget it (used by delete)

The cache holds the SAME object the pipeline mutates, so a half-finished turn is visible in
memory even though nothing was written to disk yet (see InterviewPipeline.stream_turn).
"""

from __future__ import annotations

from fastapi import HTTPException

from startup_voice.domain import InterviewSession
from startup_voice.features.sessions.store import FileSessionStore


class SessionRegistry:
    def __init__(self, store: FileSessionStore) -> None:
        self.store = store
        self.cache: dict[str, InterviewSession] = {}

    def get(self, session_id: str) -> InterviewSession:
        if session_id in self.cache:
            return self.cache[session_id]
        try:
            session = self.store.load(session_id)
        except Exception as exc:
            raise HTTPException(404, f"Session not found: {session_id}") from exc
        self.cache[session_id] = session
        return session

    def put(self, session: InterviewSession) -> None:
        self.cache[session.id] = session

    def drop(self, session_id: str) -> None:
        self.cache.pop(session_id, None)
