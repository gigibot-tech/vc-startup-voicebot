# Startup Voice Intake Agent (HTGF)

Web voice agent that runs a structured first conversation with founders and builds a
step-evaluable dossier (team, product, traction, market, financing). Replies stream into the chat
as they are written; changes the LLM wants to make to already-filled dossier fields are shown as a
red/green diff and need your OK.

## Quick start

```bash
cp .env.example .env     # add ELEVENLABS_API_KEY for spoken replies (optional)
./run.sh                 # checks Ollama + model, syncs deps, starts with auto-reload
./run.sh --no-watch      # same, but no uvicorn --reload
# open http://127.0.0.1:8140/
```

`run.sh` enables **uvicorn auto-reload** by default (watches `src/startup_voice`). It stops with a
clear message if Ollama is not running, the model is missing, or the port is taken. Without the
script: `uv sync && UVICORN_RELOAD=1 uv run startup-voice`.

## Requirements

| Needed | For | Notes |
|---|---|---|
| Python ≥ 3.11 and [uv](https://docs.astral.sh/uv/) | everything | |
| A running LLM | **required**, there is no fallback | default: [Ollama](https://ollama.com) with `ollama pull granite4.2:8b` |
| `ELEVENLABS_API_KEY` | spoken replies, cloud speech-to-text | optional |
| `DEEPGRAM_API_KEY` | second speech-to-text option | optional |
| A browser with microphone | voice input | without cloud keys the browser's Web Speech is used |

The app pings the LLM on startup and refuses to start if it does not answer.

## Configuration (`.env`, see `.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `LLM_PROVIDER` | `ollama` | `ollama`, `openai`, `openai_compatible` or `vllm` |
| `LLM_MODEL` | `granite4.2:8b` | model name |
| `LLM_BASE_URL` | `http://127.0.0.1:11434` | LLM server |
| `LLM_API_KEY` | – | only for OpenAI-compatible servers |
| `LLM_TIMEOUT` / `LLM_PROBE_TIMEOUT` | `120` / `8` | seconds per call / startup ping |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_TTS_MODEL` | – | text-to-speech |
| `DEEPGRAM_API_KEY` | – | speech-to-text |
| `STT_PROVIDER` | auto | `elevenlabs`, `deepgram` or `browser` |
| `UI_HOST` / `UI_PORT` | `127.0.0.1` / `8140` | where the app listens |
| `DATA_DIR` | `./data/sessions` | stored conversations (git-ignored) |

## How it works (voice ≠ AI)

**Voice never calls the LLM.** Mic / TTS are a separate feature. The shell injects a callback
so a transcript is handed to the interview feature as plain text (same path as typing).

```
 BROWSER                                                         BACKEND
 ───────                                                         ───────
  mic ──► voice.js  STT only
            │  POST /api/stt  (or Web Speech in-browser)
            │  → string "Wir sind zwei Gründer"
            │
            │  onTranscript(text)     ◄── injected in static/app.js
            ▼                         voice.js STOPS HERE (no LLM)
  chat.js sendText(text) ──────────► POST /api/sessions/{id}/turn/stream
            ▲                          │  interview/routes.py  (HTTP/SSE)
  typed ────┘                          ▼
                                interview/pipeline.py
                                  1. LLM write reply   → streamed tokens (immediate)
                                  2. LLM extract facts + Belege → dossier (+ review gate)
                                       │
            ◄──────────────────────────┘  SSE: delta… done
  bubble grows
  voice.speak(reply) ──────────────► POST /api/tts → mp3  (still no LLM)
```

| Layer | Module | Calls LLM? |
|---|---|---|
| Ears / mouth | `features/voice/` (`voice.js`, `stt`, `tts`, voice routes) | **No** |
| Hand-off | `static/app.js` `onTranscript → chat.sendText` | No (wiring only) |
| Brain | `features/interview/` (`chat.js`, `pipeline.py`, interview routes) | **Yes** |

Restarting the server does **not** delete conversations — they are files under `DATA_DIR`
(default `./data/sessions`). Check `GET /health` → `data_dir` / `sessions` if the sidebar looks empty.
The left **Gespräche** rail is always visible (layout icons live in the top bar).

**Review gate:** a fact for an empty field is written directly. If it differs from a filled field,
a proposal card appears in the chat (`−` old, `+` new, plus a manual box). Nothing is overwritten
until you pick one and press Speichern. Open proposals do not count for the score.
**Belege / Belastbar** is LLM-judged (`DimensionState.belege`: concrete & readable evidence), not keyword hits; Speichern re-rates via `SCORE_BELEGE_SYSTEM`.

## Project structure

Feature-sliced: each feature owns its backend and UI folder.

```
src/startup_voice/
  domain.py, language.py        shared core (models, slots, language helpers)
  web.py                        composition root: mounts the routers, serves the UI
  features/
    interview/   llm.py, prompts.py, config.py, pipeline.py, routes.py, ui/{chat,config-editor}.js
    dossier/     scoring.py, review.py, markdown.py, pdf.py, routes.py, ui/{render,actions,proposals}.js
    sessions/    store.py, registry.py, routes.py, ui/{lifecycle,session-list,meta}.js
    voice/       stt.py, tts.py, bridge.py, routes.py, ui/voice.js
    prefs/       ui/{prefs,settings}.js
  static/        index.html, app.js (wiring only), styles.css, shared/{api,state,format,diff}.js
tests/           pytest, no network (the LLM is stubbed)
```

Every `routes.py` and UI module starts with a "button → handler → backend" comment, so you can
follow any button from the page to the server. More detail: [features/startup-voice-intake.md](features/startup-voice-intake.md).

## Tests

```bash
uv sync --extra dev && uv run pytest -q
```

## Branch `pdf-upload`

`main` has no PDF upload. The branch `pdf-upload` adds it: upload a PDF, the server reads it and
the LLM proposes dossier facts **with a verbatim quote** (facts whose quote is not in the PDF are
dropped). Empty fields are filled, conflicts become the same red/green proposal cards.

- Parser: `PDF_PARSER=auto|pypdf|docling`. `pypdf` reads text PDFs only; for scanned decks use
  `uv sync --extra docs` (docling, heavy) and `PDF_PARSER=docling`.
- Limits: 20 MB per file, the first ~12 chunks (about 40k characters) of a document are read.
