# Startup Voice Intake Agent

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

### Using an EU cloud LLM instead of local Ollama

Any OpenAI-compatible endpoint works; only three variables change. Example with
[Scaleway Generative APIs](https://www.scaleway.com/en/generative-apis/) (France, first 1M tokens free):

```bash
LLM_PROVIDER=openai_compatible
LLM_BASE_URL=https://api.scaleway.ai/v1
LLM_MODEL=mistral-small-3.2-24b-instruct-2506
LLM_API_KEY=<Scaleway secret key>
```

Pick a **non-reasoning** model: reasoning models (e.g. `gpt-oss-120b`) spend `max_tokens` on hidden
thinking and can return empty replies. `run.sh` does not check non-Ollama providers; the app pings
the endpoint on startup and refuses to start if the key or model name is wrong. Interviews contain
confidential founder data, so check the provider's data-processing terms before real use
(IONOS and STACKIT process in Germany and do not log prompts).

## Voice modes: classic or LiveKit

Settings → **Voice mode** switches between two interchangeable drivers behind one `voice` object.
Both hand the transcript to the same `chat.sendText()` path, so the LLM, review gate and dossier
behave identically.

| | **Classic** (default) | **LiveKit** |
|---|---|---|
| Feel | push-to-talk: Sprechen → talk → Stopp | one press starts a hands-free call, talk and interrupt any time |
| Speech in | Web Speech / Whisper / ElevenLabs / Deepgram, silence timer ends your turn | WebRTC to a worker: VAD + Deepgram/ElevenLabs STT, echo cancellation, tunable turn end |
| Speech out | MP3 per sentence over HTTP | streamed TTS in the same call, cut instantly when you talk over it |
| Needs | nothing | a LiveKit server + the worker process |

Setup for LiveKit (the option stays greyed out in Settings until all three values exist):

```bash
# 1. LiveKit server: LiveKit Cloud project, or locally `livekit-server --dev` (ws://127.0.0.1:7880,
#    keys devkey / secret). Put the three values in .env:
#    LIVEKIT_URL=...  LIVEKIT_API_KEY=...  LIVEKIT_API_SECRET=...
# 2. Start the app as usual, plus the voice worker in a second terminal:
uv run --extra livekit-voice startup-voice-agent dev
```

The worker needs `DEEPGRAM_API_KEY` or `ELEVENLABS_API_KEY` (speech-to-text) and
`ELEVENLABS_API_KEY` (text-to-speech). It never calls the LLM: it forwards what you said and speaks
the reply text the browser sends it. If the worker is not running, pressing Sprechen shows
"Voice agent not responding" after 15 s; switch back to Classic in Settings at any time.
**Browser Whisper in a call:** set Settings → STT to *Whisper (Browser)* and pick LiveKit. The browser
then listens (energy-based speech detection + your Transformers.js Whisper, mic stays in the browser)
and the worker only speaks, so no Deepgram/ElevenLabs STT key is needed. Trade-offs: simpler speech
detection than the server's, a short delay while Whisper transcribes after you stop, first start loads
the model. Any other STT choice = the worker listens.

Speech-to-text on the worker can also be a **local Whisper server**: run an OpenAI-compatible Whisper server and set
`LIVEKIT_STT=local`, `LIVEKIT_STT_BASE_URL`, `LIVEKIT_STT_MODEL` (audio stays on your machine; no live
words while you talk). Tuning (`LIVEKIT_ENDPOINT_MIN`, `LIVEKIT_TURN_DETECTOR`, …) is in `.env.example`.

Adding a third mode = a driver in `features/voice/ui/`, a transport in
`features/voice/transports/`, one line each in `static/app.js` and `transports/__init__.py`.

## Public Idea Board

Founders can publish parts of their dossier (button **Öffentlich teilen…** in the dossier panel). Pages
are public without login: `/board` lists the dossiers whose authors also chose to be listed, `/d/<link>`
shows one. The look follows the iDO! marketing site.

- **Private by default.** Nothing is public until the founder ticks sections, reads the notes and agrees.
  Listing on `/board` is a second, separate consent; without it the page is reachable only by its link.
- **Product, Traction, Market, Financing only.** `team` is rejected by the server, whatever a client sends.
- **Snapshot.** The text is copied at publish time and editable in the dialog before publishing.
- **No accounts, so an owner key.** Shown once (`ik_…`), only its SHA-256 hash is stored. It is needed to
  update or withdraw. Withdrawing deletes the text, title and e-mail; slug and consent record stay.
- **Optional e-mail** only with its own consent, never published. (No verification mail is sent yet.)
- **Nothing tracked:** no IP addresses or user agents stored, no cookies, no third-party fonts, author
  text rendered as plain text only; pages are `noindex` unless `BOARD_INDEXABLE=1`. Reports are stored
  in `DATA_DIR/public/reports.jsonl`; there is no moderation screen yet.
- **Before a real public launch:** the consent wording is a DRAFT (`CONSENT_VERSION`), and the app has no
  per-visitor sessions: every visitor could open every conversation. Publishing on a public server needs
  session isolation first (see `docs/ido-journey/PUBLIC_SHARING.md`).

Data lives in `DATA_DIR/public/<link>.json`. Code: `src/startup_voice/features/board/`.

## Running inside ido-core

ido-core can embed this app in an iframe (idea page → *Interview* tab, enabled by its
`VITE_VOICE_INTAKE_URL`). Accepted dossier answers then flow into the idea's venture fields:

1. Set `IDO_ORIGINS=<ido-core origin>` here. Without it nobody else can frame the page.
2. The page posts changed fields to its parent (`postMessage`, explicit target origin, one trusted
   origin only); **ido-core writes them with the founder's own session** through
   `apply_venture_field_change`. This server never holds a Supabase token and never calls ido-core.
3. Values a founder wrote in ido-core themselves are never overwritten; the interview shows
   "n Felder nicht übernommen" instead.

Mapping (dossier field → venture field), rules and the validator: `docs/ido-journey/PLAN.md`;
the machine-readable contract is `src/startup_voice/features/ido/journey_map.json`.

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
