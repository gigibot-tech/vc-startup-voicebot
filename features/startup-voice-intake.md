# Startup Voice Intake (HTGF)

Web voice agent that runs a structured first conversation with founders and stores
a step-evaluable dossier under `data/sessions/<id>/`.

## Package layout (Feature-Sliced Design / vertical slices)

Principle: **feature colocation** — each product capability owns its backend *and* UI
next to each other (also called Feature-Sliced Design or vertical slices), instead of
grouping by technical layer (`static/js/*` vs flat `*.py`).

```
startup_voice/
  web.py, pipeline.py, store.py, domain.py, …   # shell / core
  static/app.js, styles.css, shared/{api,format}.js
  features/
    dossier/   markdown.py, pdf.py, fonts/, ui/dossier-schema.js
    voice/     stt.py, tts.py, bridge.py, ui/voice.js
    sessions/  ui/session-list.js
    prefs/     ui/prefs.js
```

UI is served as `/static/features/<name>/…` from each feature’s `ui/` folder.
`static/app.js` is the composition shell that imports feature modules.

## Voice modes

| Mode | Transport | Notes |
|------|-----------|-------|
| **Shipped** | **ElevenLabs STT** (Scribe, same API key) / Deepgram / Web Speech + **ElevenLabs TTS** | Mic → `/api/stt?provider=` → turn; TTS with tonality (stability/similarity/style/speed) |
| Bridge only | PersonaPlex helpers in `features/voice/bridge.py` | `/personaplex-config` + tool-webhook exist; **no LiveKit/GPU client in UI** — missing mode is not a `.env` gap |
| Planned | LiveKit agent process | Needs GPU PersonaPlex server + room join |

### Voice UX
- Phases: **listening → thinking → speaking → idle** (orb + status). Sending a turn clears listening/speaking immediately so UI does not stick on “Spricht…/Hört zu…”.
- Deepgram: click mic to record; auto-stop on short silence, or click again to send. Fallback: Web Speech when no API key.

UI session picker loads `GET /api/sessions` and resumes `session.json` from disk.

### Default layout
- **Main = HTGF Hero** (team card + „Dein Startup / Erstgespräch“ — earlier look)
- Optional Main = Compact Chat
- **Nav oben** + **Dossier unter dem Chat** (rounded card in Hero mode)
- Optional: Nav links / Dossier rechts
- **Gespräch löschen** → `DELETE /api/sessions/{id}` (chat + files)
- **Dossier leeren** → clear slots only
- **Dossier abschließen** → end of dossier panel; warns if incomplete / already finalized; then returns to chat picker
- **Neues Gespräch** → picker first (no auto-TTS); confirm to start quietly
- **App state SSOT** → `appState.{view,sessionId,session,list}` + URL `?s=<id>`; sidebar/select/dossier/finalize all use `sessionId` (stale responses ignored)
- **Voice I/O** → `SttRouter` (Strategy + fallback chain), same composition style as `InterviewPipeline(llm=…)` — **not** inside the interview pipeline. `POST /api/voice/preflight` fail-fast DNS/key before mic; Sprechen stops TTS first; cloud STT → browser fallback

### Einstellungen (UI)
| Gruppe | Was |
|--------|-----|
| **Sprache** | STT-Provider + Antwortsprache (`de-DE` / `en-US`) |
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
| Dossier abschließen | Finalize with warnings; then chat Auswahl |
| Markdown / PDF / JSON | Export readable MD, print PDF, or raw `session.json` |
| Field labels | UI + exports use German labels from `DIMENSIONS_SPEC.field_labels` (no snake_case) |
| Fragenkatalog | Edit slot question blueprints (feeds agent paraphrase) |
| Dossier leeren | Wipe slot fields, keep chat |
| Gespräch löschen | Delete whole session from disk |

## Collect vs score

1. **fill_objects** — **LLM JSON extract** into `objects/<slot>.json` (no keyword snippets)
2. **evaluate** — deterministic coverage/specificity on files (no LLM)
3. **decide_reply** — ask next gap or finalize → `steps/turn_XX.json` + `dossier.md`

Run with Ollama (`granite4.2:8b` default). Extract + reply + summary are **LLM-only** (no heuristic fallback). Deterministic file scoring remains for coverage.

## SSOT slots (`domain.DIMENSIONS_SPEC`)

`team` · `product` · `traction` · `market` · `financing` — each with `required_fields`.

## Run

```bash
cd webapps/startup-voice-agent
uv sync
uv run startup-voice
# http://127.0.0.1:8140/
```

## Design

HTGF Jan-Bernhardt tokens: fond `#F0EEEB`, berry/mint/lime accents, asymmetric
`team-qa` bubbles, glass header, pill buttons.
