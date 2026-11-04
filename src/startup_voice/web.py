"""Composition root: builds the shared objects, mounts each feature's router, serves the UI.

This file contains NO endpoints of its own except "/" (the HTML page). Every route lives in
the feature that owns it, next to a docstring explaining which button triggers it:

    features/interview/routes.py   turn + turn/stream, finalize, tool-webhook, interview-config
                                   (the ONLY routes that make the LLM do work)
    features/sessions/routes.py    list / start / open / delete a conversation
    features/dossier/routes.py     schema labels, markdown/pdf export, clear, proposal resolve
    features/voice/routes.py       /health, voice/preflight, stt, tts, personaplex-config
                                   (speech only, never calls the LLM)

End-to-end path of one spoken answer::

    browser: mic -> voice.js (STT) -> onTranscript(text) -> interview/ui/chat.js sendText(text)
        |  POST /api/sessions/{id}/turn/stream
        v
    interview/routes.py turn_stream()        HTTP + SSE framing
        v
    interview/pipeline.py stream_turn()      orchestration, persistence
        |-- LLM call #1  extract facts -> dossier   (complete(), not streamed)
        `-- LLM call #2  write the reply            (stream(),   token by token)
        v
    interview/llm.py ConfigurableLLM         Ollama / OpenAI-compatible
        v
    SSE back to the browser; chat.js paints the bubble, then voice.speak(reply)
    -> POST /api/tts -> mp3 (ElevenLabs).

Dependency direction (no cycles): interview -> sessions -> dossier -> domain/language (root),
voice -> domain/language. The root modules ``domain.py`` and ``language.py`` are the shared core.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from startup_voice.features.dossier import routes as dossier_routes
from startup_voice.features.interview import routes as interview_routes
from startup_voice.features.interview.config import InterviewConfigStore
from startup_voice.features.interview.llm import ConfigurableLLM
from startup_voice.features.interview.pipeline import InterviewPipeline
from startup_voice.features.sessions import routes as sessions_routes
from startup_voice.features.sessions.registry import SessionRegistry
from startup_voice.features.sessions.store import FileSessionStore
from startup_voice.features.voice import routes as voice_routes
from startup_voice.features.voice import get_router

_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(_ROOT / ".env")
_PKG = Path(__file__).resolve().parent
_STATIC = _PKG / "static"
_FEATURES = _PKG / "features"
_DEFAULT_DATA = _ROOT / "data" / "sessions"

# Features that ship browser code in features/<name>/ui  ->  served at /static/features/<name>/
_UI_FEATURES = ("dossier", "voice", "sessions", "prefs", "interview")


def _llm() -> ConfigurableLLM:
    """Always use the configured live LLM — no heuristic fallback."""
    llm = ConfigurableLLM()
    prev = os.environ.get("LLM_TIMEOUT")
    os.environ["LLM_TIMEOUT"] = os.getenv("LLM_PROBE_TIMEOUT", "8")
    try:
        llm.complete("ping", "ok", max_tokens=4)
    finally:
        if prev is None:
            os.environ.pop("LLM_TIMEOUT", None)
        else:
            os.environ["LLM_TIMEOUT"] = prev
    return llm


def create_app(*, llm: ConfigurableLLM | None = None) -> FastAPI:
    data_dir = Path(os.getenv("DATA_DIR", str(_DEFAULT_DATA)))
    store = FileSessionStore(data_dir)
    # Config lives with sessions root (…/sessions/interview_config.json or DATA_DIR).
    config_store = InterviewConfigStore(data_dir / "interview_config.json")
    pipeline = InterviewPipeline(llm or _llm(), store, config_store=config_store)
    registry = SessionRegistry(store)

    app = FastAPI(title="Startup Voice Intake", version="0.1.0")
    app.state.pipeline = pipeline
    app.state.store = store
    app.state.config_store = config_store
    app.state.sessions = registry.cache
    app.state.stt = get_router()

    app.include_router(voice_routes.build_router(registry=registry))
    app.include_router(sessions_routes.build_router(registry=registry, pipeline=pipeline))
    app.include_router(
        interview_routes.build_router(
            registry=registry, pipeline=pipeline, config_store=config_store
        )
    )
    app.include_router(dossier_routes.build_router(registry=registry, pipeline=pipeline))

    @app.get("/")
    def index() -> FileResponse:
        """The single HTML page; all behaviour is in the ES modules it loads."""
        return FileResponse(_STATIC / "index.html")

    # Feature-colocated UI (features/<name>/ui → /static/features/<name>/…)
    for feat in _UI_FEATURES:
        ui_dir = _FEATURES / feat / "ui"
        if ui_dir.is_dir():
            app.mount(f"/static/features/{feat}", StaticFiles(directory=ui_dir), name=f"feat-{feat}")

    app.mount("/static", StaticFiles(directory=_STATIC), name="static")
    return app


def main() -> None:
    import uvicorn

    host = os.getenv("UI_HOST", "127.0.0.1")
    port = int(os.getenv("UI_PORT", "8140"))
    print(f"Startup Voice Intake: http://{host}:{port}/")
    uvicorn.run("startup_voice.web:create_app", factory=True, host=host, port=port)


if __name__ == "__main__":
    main()
