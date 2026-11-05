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
        |-- LLM call #1  write the reply            (stream(),   token by token)
        `-- LLM call #2  extract facts -> dossier   (complete(), after stream)
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
from fastapi import FastAPI, Request
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
    # Absolute path so a restart never silently points at a different cwd's ./data/sessions.
    data_dir = Path(os.getenv("DATA_DIR", str(_DEFAULT_DATA))).expanduser().resolve()
    store = FileSessionStore(data_dir)
    app_data_dir = data_dir  # closed over by /health
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

    # Local UI: never cache HTML/JS/CSS. uvicorn --reload only restarts on *.py;
    # without this, browsers keep serving stale feature UI via 304 Not Modified.
    @app.middleware("http")
    async def no_cache_ui(request: Request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path == "/" or path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response

    app.include_router(voice_routes.build_router(registry=registry))
    app.include_router(sessions_routes.build_router(registry=registry, pipeline=pipeline))
    app.include_router(
        interview_routes.build_router(
            registry=registry, pipeline=pipeline, config_store=config_store
        )
    )
    app.include_router(dossier_routes.build_router(registry=registry, pipeline=pipeline))

    # Surface the session store path so a "where did my chats go?" restart is diagnosable.
    @app.get("/api/debug/data-dir")
    def debug_data_dir() -> dict:
        return {
            "data_dir": str(app_data_dir),
            "sessions": len(store.list_ids()),
            "default": str(_DEFAULT_DATA.resolve()),
        }

    @app.get("/")
    def index() -> FileResponse:
        """The single HTML page; all behaviour is in the ES modules it loads."""
        return FileResponse(
            _STATIC / "index.html",
            headers={
                "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                "Pragma": "no-cache",
            },
        )

    # Feature-colocated UI (features/<name>/ui → /static/features/<name>/…)
    for feat in _UI_FEATURES:
        ui_dir = _FEATURES / feat / "ui"
        if ui_dir.is_dir():
            app.mount(f"/static/features/{feat}", StaticFiles(directory=ui_dir), name=f"feat-{feat}")

    app.mount("/static", StaticFiles(directory=_STATIC), name="static")
    return app


def main() -> None:
    import sys
    import uvicorn

    host = os.getenv("UI_HOST", "127.0.0.1")
    port = int(os.getenv("UI_PORT", "8140"))
    data_dir = Path(os.getenv("DATA_DIR", str(_DEFAULT_DATA))).expanduser().resolve()
    # ./run.sh enables reload by default; override with --no-watch or UVICORN_RELOAD=0.
    argv = set(sys.argv[1:])
    env_reload = os.getenv("UVICORN_RELOAD", "1").strip().lower() not in {"0", "false", "no", "off"}
    reload = ("--no-watch" not in argv and "--no-reload" not in argv) and (
        env_reload or "--watch" in argv or "--reload" in argv
    )
    print(f"Startup Voice Intake: http://{host}:{port}/")
    print(f"Session store (DATA_DIR): {data_dir}")
    print(f"Auto-reload: {'on' if reload else 'off'}  (./run.sh --no-watch to disable)")
    if reload:
        print("  note: --reload watches Python under src/startup_voice only;")
        print("        JS/CSS/HTML are served live from disk (Cache-Control: no-store).")
    uvicorn.run(
        "startup_voice.web:create_app",
        factory=True,
        host=host,
        port=port,
        reload=reload,
        reload_dirs=[str(_PKG)] if reload else None,
    )


if __name__ == "__main__":
    main()
