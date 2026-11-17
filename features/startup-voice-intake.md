# Startup Voice Intake

Web voice agent that runs a structured first conversation with founders and stores
a step-evaluable dossier under `data/sessions/<id>/`.

## Package layout (Feature-Sliced Design / vertical slices)

Principle: **feature colocation** — each product capability owns its backend *and* UI
next to each other (also called Feature-Sliced Design or vertical slices), instead of
grouping by technical layer (`static/js/*` vs flat `*.py`).

```
startup_voice/
  domain.py, language.py        # shared core
  web.py                        # composition root: mounts each feature's router
  static/app.js, index.html, styles.css, shared/{api,state,format,diff}.js
  features/
    interview/ llm.py, prompts.py, config.py, pipeline.py, routes.py, ui/{chat,config-editor}.js
    dossier/   scoring.py, review.py, markdown.py, pdf.py, fonts/, routes.py,
               ui/{dossier-schema,render,actions,proposals}.js
    sessions/  store.py, registry.py, routes.py, ui/{lifecycle,session-list,meta}.js
    voice/     stt.py, tts.py, bridge.py, routes.py, ui/voice.js
    prefs/     ui/{prefs,settings}.js
```

UI is served as `/static/features/<name>/…` from each feature’s `ui/` folder.
`static/app.js` only creates the feature modules, wires them and boots. Each `routes.py` and UI
module documents which button triggers which backend flow.

## Voice modes

Two drivers behind one `voice` object (`voice/ui/voice-mode.js`): **classic** and **livekit**. Server side each is a `VoiceTransport` (`voice/transports/`); `/health` lists the usable ones.

| Mode | Transport | Notes |
|------|-----------|-------|
| **Shipped** | **ElevenLabs STT** (Scribe, same API key) / **Whisper (Transformers.js)** / Deepgram / Web Speech + **ElevenLabs TTS** | Mic → cloud `/api/stt` or in-browser Whisper → turn; TTS with tonality (stability/similarity/style/speed) |
| **LiveKit** (opt-in) | Hands-free WebRTC call; worker `features/voice/livekit_worker.py` does VAD + STT + TTS | Settings > Voice mode. Browser driver `voice/ui/voice-livekit.js`, token route `POST /api/voice/join`, wire protocol `voice/livekit_protocol.py`. The worker never calls the LLM; the browser stays the orchestrator |
| Bridge only | PersonaPlex helpers in `features/voice/bridge.py` | `/personaplex-config` + tool-webhook exist; speech-to-speech needs a GPU PersonaPlex server and has no UI client |

## Browser WebGPU (Transformers.js)

Settings (`#prefsBar`):
- **STT** `#sttSel`: `elevenlabs` | `whisper` | `deepgram` | `browser`
- **TTS** `#ttsSel`: `local` (default, downloadable MMS DE/EN via Transformers.js) | `browser` (Web Speech) | `elevenlabs`
- **LLM** `#llmSel`: `ollama` (server, default) | `granite-3b` (Granite 4 3B WebGPU) | `gemma-3n-e2b` (Gemma 3n E2B Nano Mobile WebGPU)

When `llm` is `granite-3b` or `gemma-3n-e2b`, chat uses the same loaded `text-generation` pipeline for Call #1 (spoken reply) and Call #2 (5-slot JSON extract):

1. `POST /api/sessions/{id}/turn/prepare` → `{reply_system, reply_user, extract_system, extract_user, …}`
2. Worker runs reply (streamed) then extract on `onnx-community/granite-4.0-micro-ONNX-web` (`q4f16`) or `onnx-community/gemma-3n-E2B-it-ONNX` (`q4f16`)
3. `POST /api/sessions/{id}/turn/reply` saves Call #1 immediately; `POST /api/sessions/{id}/turn/commit` `{raw_reply, raw_extract}` runs the dossier review/score gate
4. **Speaking during dossier update:** Clicking `Sprechen` while Call #2 (`Updating dossier…`) is still running starts recording immediately without aborting the background extract; if the new utterance is submitted before Call #2 finishes, `sendText()` awaits `inFlightExtractPromise` so the new reply always uses the freshly updated dossier.

Whisper STT uses `onnx-community/whisper-tiny` via the shared worker + reusable `ModelStatusCard` (`static/shared/model-manager.js`, `transformers-worker.js` on `@huggingface/transformers@4`). Local TTS (default) uses `Xenova/mms-tts-deu` / `Xenova/mms-tts-eng` on the same worker. Download progress syncs to `#processBanner`. Whisper is the default STT fallback when no cloud keys are configured. Continue-asking has matching `/continue/prepare` + `/continue/commit`.

### Voice UX
- Phases: **listening → thinking → speaking → idle** (orb + status). Sending a turn clears listening/speaking immediately so UI does not stick on “Speaking…/Listening…”.
- Listening dock: ChatGPT-style **waveform + Stop** (`#listenBar`); **live transcript** is a provisional user chat bubble (`paintSttPreview` → `.team-qa--live`), not the composer.
- Cloud / Whisper: click mic to record; **Stop** (`#listenStopBtn`) ends the utterance and sends (mic click also stops). No silence auto-stop. Fallback: Web Speech when no API key.
- **UI chrome is English**; interview speech language stays DE/EN via `#langSel`.

UI session picker loads `GET /api/sessions` and resumes `session.json` from disk.

### Default layout
- **Main = Hero** (team card + „Dein Startup / Erstgespräch“ — earlier look); **Sprechen** only once a session is open (above conflicts)
- Optional Main = Compact Chat
- **Nav oben, eine Zeile** — STT-Badge versteckt; **Neues Gespräch** in der Sidebar; Gespräch-Dropdown nur bei eingeklappter Sidebar und wenn die Zeile nicht überläuft (unter 720px immer weg)
- **Dossier unter dem Chat** (rounded card in Hero mode)
- Optional: Nav links / Dossier rechts
- **Gespräch löschen** → `DELETE /api/sessions/{id}` (chat + files)
- **Dossier leeren** → clear slots only
- **Dossier abschließen** → end of dossier panel; warns if incomplete; writes an immutable timestamped snapshot `dossiers/vXX_<UTC>_dossier.{md,json,pdf}` + appends to `session.dossier_versions` (each session can hold multiple finalized versions; stays in the session with per-version MD/PDF/JSON links)
- **Home/picker** → only **Neues Gespräch jetzt starten** (no Sprechen on home); mic appears after the session opens
- **App state SSOT** → `appState.{view,sessionId,session,list}` + URL `?s=<id>`; sidebar/select/dossier/finalize all use `sessionId` (stale responses ignored)
- **Voice I/O** → `SttRouter` (Strategy + fallback chain), same composition style as `InterviewPipeline(llm=…)` — **not** inside the interview pipeline. `POST /api/voice/preflight` fail-fast DNS/key before mic; Sprechen stops TTS first; cloud STT → browser fallback

### Einstellungen (UI)
| Gruppe | Was |
|--------|-----|
| **Sprache** | DE/EN in der **Kopfzeile** (`#langSel`) — aktives Gespräch + Prefs für neue; STT-Provider bleibt in Einstellungen |
| **Tonalität** | Stimme an/aus, Tempo, Stabilität, Ähnlichkeit, Ausdruck (ElevenLabs) |
| **System-Prompt** | Begrüßung + Reply-System-Prompt → `PUT /api/interview-config` |
| **Fragenkatalog** | Blueprint-Fragen pro Dimension im Dossier-Panel (rechts/unten) |

Persistenz: `data/sessions/interview_config.json` (Server-SSOT für Prompt + Katalog).

### Voice controls
- Mic = **Sprechen** / **Stoppen** / **Stopp Stimme** / **Abbrechen** (klar sichtbar, berry when live)
- Turn send: Composer zeigt „Wartet…“ — Sidebar lädt **nicht** mit (nur bei open/finalize)

### Dossier actions
| Button | Meaning |
|--------|---------|
| Dossier extrahieren | Full-conversation extract focused on **MISSING_FOCUS** (open fields, lowest coverage first — not all 5 slots equally, not ASK_NOW). Live Dossier `#dossierExtractBtn` |
| Dossier abschließen | Finalize with warnings; then chat Auswahl |
| Markdown / PDF / JSON | Export readable MD, print PDF, or raw `session.json` |
| Field labels | UI + exports use German labels from `DIMENSIONS_SPEC.field_labels` (no snake_case) |
| Fragenkatalog | Edit slot question blueprints (feeds agent paraphrase) |
| Dossier leeren | Wipe slot fields, keep chat |
| Gespräch löschen | Delete whole session from disk |

## Conflicts & auto-resolve

- Extract attaches per-field **`confidence` (0–1)** on proposals (fallback: slot belege, else 0.5).
- Prefs **Auto-resolve if confidence ≥** (default **0.75**; Off = 1.01): client POSTs `choice=new` for matching open proposals after render; history in `session.conflict_history` (expandable “Resolved conflicts”).
- Reply prompt always appends **REPLY_NO_REASK** + `already_answered`; **ASK_NOW** comes from post-extract coverage (no keyword topic matching). Pace ≈5 substantive turns; 1–2 short questions OK on empty gaps.

## Honest extract + agent end

- Extract fills a field **only** when the founder clearly answered that field; otherwise `""` / null (OK). No blanket “noch nicht” across unrelated slots. Merge drops literal `null`/`none`/etc.
- When intake is ready (or further questions would only rehash), reply may end with **`[[intake:end]]`** (stripped before TTS). SSE `offer_end` shows `#intakeEnd`: **Continue** (keep chatting) or **Finalize dossier** (existing finalize — user decides; never auto-finalize).

## Collect vs score

1. **decide_reply** — **Thinking…** first; ask **ASK_NOW** from prior coverage; never re-ask `already_answered`; may offer `[[intake:end]]`.
2. **fill_objects** — **Updating dossier…** always after the spoken reply (+ `belege` / field `confidence`). Review gate (`dossier/review.py`). SSE: Thinking… → deltas → `reply` → extract status → `done`. Busy UI = topbar `#processBanner`; interrupt needs confirm.
3. **evaluate** — coverage + LLM Belege after extract; persist `steps/turn_XX.json` + `dossier.md`

Run with Ollama (`granite4.2:8b` default). Extract + Belege + reply + summary are **LLM-only**.

## SSOT slots (`domain.DIMENSIONS_SPEC`)

`team` · `product` · `traction` · `market` · `financing` — each with `required_fields`.

## Run

```bash
cd webapps/startup-voice-agent
./run.sh        # or: uv sync && uv run startup-voice
# http://127.0.0.1:8140/
```

## Design

Design tokens: fond `#F0EEEB`, berry/mint/lime accents, asymmetric
`team-qa` bubbles, glass header, pill buttons.
