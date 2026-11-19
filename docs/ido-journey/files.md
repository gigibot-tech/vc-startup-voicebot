# files.md — Dateien des Vorhabens „Dossier = Journey von ido-core“

> Neu angelegt am 2026-11-17: Die im Auftrag genannte `files.md` existiert nicht. Hier wird jede
> erstellte oder geänderte Datei des Vorhabens eingetragen (Phase · Pfad · Zweck · Status).

| Phase | Datei | Zweck | Status |
|---|---|---|---|
| 0 | `docs/ido-journey/PLAN.md` | Implementierungsplan, Interpretation, Risiken, offene Fragen, Selbstanalyse | geschrieben |
| 0 | `docs/ido-journey/dossier-journey-map.json` → `src/startup_voice/features/ido/journey_map.json` | maschinenlesbarer Vertrag Dossier-Feld → Venture-Feld, Placement, Lektionsbelege, Schreibregeln | geschrieben, validiert |
| 0 | `docs/ido-journey/validate_map.py` | prüft den Vertrag gegen das Dossier-Schema und gegen ido-core (Vokabular, Lektions-Slugs) | geschrieben, läuft grün |
| 0 | `tests/test_ido_journey_map.py` | 10 Tests, davon 5 mit absichtlich kaputtem Vertrag | grün |
| 0 | `docs/ido-journey/files.md` | dieses Verzeichnis | geschrieben |
| 1 | `docs/ido-journey/dossier-journey-map.json` | geändert: `funding` = hypothesis, Migrationspfade, Statusregel (in Phase 2 verschoben, siehe unten) | validiert |
| 1 | `docs/ido-journey/validate_map.py` | geändert: prüft die gelieferte Migration (Seed-Art, Origin-Liste) | grün |
| 1 | `tests/test_ido_journey_map.py` | geändert: +4 Tests (3 negativ) | 14 grün |
| 1 | `docs/ido-journey/PLAN.md` | geändert: Phase 1 + Korrekturen | aktualisiert |

## Punkt 0 (2026-11-18): Modus erkennbar + Start

| Datei | Art | Zweck | Status |
|---|---|---|---|
| `src/startup_voice/features/voice/ui/voice.js` | geändert | `setModeUi`, Pille neben dem Mikrofon, modusabhängige Knopfwörter („Live-Gespräch starten“, „Auflegen“) | im Browser geprüft (DE/EN) |
| `src/startup_voice/features/voice/ui/voice-livekit.js` | geändert | liefert die Live-Beschriftung, Pille wird bei Verbindung „● LIVE“ | 4 neue Tests |
| `src/startup_voice/features/prefs/ui/chrome-i18n.js` | geändert | überschreibt die Modus-Beschriftung nicht mehr | |
| `src/startup_voice/static/styles.css` | geändert | `.mode-pill` | |
| `run.sh` | geändert | lädt das Ollama-Modell vor (der Start scheiterte nach Leerlauf am 8-s-Ping) | geprüft |
| `tests/js/voice-modes.test.mjs` | geändert | +4 Tests | 75 grün |
| `docs/ido-journey/PUBLIC_SHARING.md` | neu | priorisierte Planung: Board, Teilen, Besitzer-Schlüssel, DSGVO | Entwurf |

## Öffentlicher Idea Board in der Voice-App (2026-11-19)

| Datei | Art | Zweck | Status |
|---|---|---|---|
| `src/startup_voice/features/board/store.py` | neu | Regeln (nie `team`, Größen, Einwilligungen), Besitzer-Schlüssel (nur Hash), Listung, Zurückziehen löscht Text, Meldungen, Ratenbegrenzung | 25 Tests, 7 von 8 Brüchen erkannt (der achte ist gleichwertig) |
| `src/startup_voice/features/board/routes.py` | neu | `publish-preview`, `publish`, `/api/public/*`, Seiten `/board` und `/d/<link>` | Tests + Browser |
| `src/startup_voice/features/board/ui/board.html`, `dossier.html`, `public.css`, `board-page.js`, `dossier-page.js` | neu | öffentliche Seiten im Marketing-Look, nur Textknoten, keine Fremd-Schrift, kein Inline-Skript | im Browser geprüft |
| `src/startup_voice/features/board/ui/publish.js`, `publish-form.js` | neu | Dialog „Öffentlich teilen…“ (DE/EN), reine Formular-Helfer | 6 Tests, Dialog im Browser geprüft |
| `src/startup_voice/web.py`, `static/index.html`, `static/app.js`, `static/styles.css`, `features/prefs/ui/chrome-i18n.js` | geändert | Router, Schutz-Header (nosniff, no-referrer, noindex), Knopf + Dialog | |
| `src/startup_voice/features/board/ui/home-board.js`, `ido-logo.svg` | neu | Idea Board neben „Gespräch wählen“ auf dem Startbildschirm (Zweispaltig, schmal untereinander); „Idea Board by iDO!“ mit dem **Logo der Marketingseite** (Inline-SVG vom Header von ido-marketing.vercel.app, 6 Pfade, feste Farben; nicht mehr das ido-core-Logo), auch auf den öffentlichen Seiten | im Browser geprüft |
| `tests/test_board.py`, `tests/js/publish-form.test.mjs` | neu | siehe oben; Wächter: öffentliche JS-Dateien ohne `innerHTML` | grün |
| `.env.example`, `README.md` | geändert | `IDO_APP_URL`, `BOARD_INDEXABLE`, Abschnitt „Public Idea Board“ | |

## Start & Deployment (2026-11-19)

| Datei | Art | Zweck | Status |
|---|---|---|---|
| `~/Documents/old_pilots/.claude/launch.json` | neu | Claude findet die Startkonfiguration im **Hauptordner der Sitzung**: Einträge `ido-core` (Port 3000) und `startup-voice-agent` (Port 8140) | `preview_start` startet ido-core |
| `ido-core/.claude/launch.json`, `startup-voice-agent/.claude/launch.json` | neu | gleiche Einträge für den Fall, dass ein Projekt direkt als Sitzungsordner geöffnet wird | |
| `ido-core/netlify.toml` | neu | Build (`npm run build`, `dist`, Node 20), Cache-Header, `noindex` für `/d/*`; die SPA-Weiterleitung liegt schon in `public/_redirects` | nicht auf Netlify getestet |
| `ido-core/.env.local`, `startup-voice-agent/.env` | je 1 Zeile ergänzt | `VITE_VOICE_INTAKE_URL` bzw. `IDO_ORIGINS=http://localhost:3000` | lokal |
| `startup-voice-agent/run.sh` | geändert (früher) | lädt das Ollama-Modell vor dem Start | |

## Punkt 2 (2026-11-19): Teilen mit Konto, in ido-core (nicht committet)

| Datei | Art | Zweck | Status |
|---|---|---|---|
| `supabase/migrations/idea_public_dossiers.sql` | neu | Tabelle, RLS, `publish_`/`unpublish_interview_dossier`, `get_public_dossier` (Step 64) | auf Postgres 14 geprüft, zweimal angewendet |
| `src/lib/public-dossier/sections.ts` | neu | erlaubte Bereiche (nie `team`), Größenlimits, Einwilligungstext (Entwurf), Karten lesen | 12 Tests, 5 Brüche belegt |
| `src/lib/public-dossier/service.ts` | neu | RPC-Aufrufe | nur Syntax |
| `src/components/intake/PublishDossierPanel.tsx` | neu | Auswahl, Vorschau, Einwilligung, Veröffentlichen/Zurückziehen | ido-core läuft; Panel noch nicht mit Login ausprobiert |
| `src/components/marketplace/PublicDossierPage.tsx` | neu | öffentliche Seite `/d/:slug`, `noindex` | im Browser geprüft (ungültiger Link) |
| `src/components/intake/IntakeView.tsx`, `src/App.tsx` | geändert | Panel einbinden, Route `/d/:slug` (App.tsx enthält zusätzlich deine eigenen offenen Änderungen) | nur Syntax |
| `src/lib/intake-bridge/notes.ts` | geändert | `cardBody()` | getestet |
| `supabase/migrations/APPLY_ORDER.md`, `docs/features/voice-intake.md`, `.env.local.example` | geändert | Step 64, Abschnitt „Sharing publicly“, optionale `VITE_PUBLIC_DOSSIER_REPORT_EMAIL` | |

## Punkt 1 (2026-11-18): Dossier → Notizkarten auf dem Board

| Repo | Datei | Art | Zweck | Status |
|---|---|---|---|---|
| Voice | `src/startup_voice/features/ido/notes.py` | neu | `dossier_to_notes()`: Körper je Bereich, nur Gefülltes, ohne Belege/Gespräch | 8 Tests |
| Voice | `src/startup_voice/features/ido/routes.py`, `delta.py` | geändert | Endpunkt liefert `notes`; Revision zählt Karten mit | |
| Voice | `src/startup_voice/features/ido/ui/ido-bridge.js` | geändert | sendet geänderte Karten, klarer Hinweis („1 Karte auf dem Board …“) | +5 Tests |
| Voice | `src/startup_voice/features/ido/journey_map.json` | geändert | Abschnitt `notes` (Bereiche, Titelpräfix, Update-Regel) | |
| Voice | `docs/ido-journey/validate_map.py`, `tests/test_ido_journey_map.py` | geändert | Parität der Karten-Bereiche und Titel mit ido-core (+3 Tests) | grün |
| Voice | `tests/test_ido_notes.py` | neu | Karten-Tests | grün |
| ido-core | `src/lib/intake-bridge/notes.ts` | neu | Titel, Fußzeile mit Prüfsumme, `applyIntakeNotes` (nur unveränderte Karten aktualisieren) | 21 Tests, 5 absichtliche Brüche belegt |
| ido-core | `src/lib/intake-bridge/protocol.ts` | geändert | Karten erlaubt (5 Schlüssel, ≤3000 Zeichen); Felder dürfen leer sein, wenn Karten da sind | +6 Tests |
| ido-core | `src/lib/intake-bridge/adapter.ts` | geändert | `readBoardNotes` / `createBoardNote` / `updateBoardNote` | nur Syntax, nicht gegen die echte Datenbank |
| ido-core | `src/components/intake/IntakeView.tsx` | geändert | wendet Felder **und** Karten an, Nachrichten nacheinander | nur Syntax |
| ido-core | `docs/features/voice-intake.md` | neu | Funktion, Regeln, Einrichtung | Prettier sauber |

## Phase 2 in diesem Repo (Voice-App)

| Phase | Datei | Art | Zweck | Status |
|---|---|---|---|---|
| 2 | `src/startup_voice/features/ido/journey_map.json` | verschoben aus `docs/ido-journey/` | Vertrag, jetzt Teil des Pakets (Laufzeit liest ihn); `problem`/`solution` direkt | validiert |
| 2 | `src/startup_voice/features/ido/__init__.py` | neu | Paket | |
| 2 | `src/startup_voice/features/ido/delta.py` | neu | `dossier_to_venture_delta()` (rein), `revision()` | 12 Tests |
| 2 | `src/startup_voice/features/ido/routes.py` | neu | `GET /api/sessions/{id}/ido-delta`, `GET /api/ido/config`, `IDO_ORIGINS` | |
| 2 | `src/startup_voice/features/ido/ui/ido-bridge.js` | neu | postMessage-Brücke (Handshake, nur Änderungen, Ergebnis/Hinweis) | 10 Tests |
| 2 | `src/startup_voice/domain.py` | geändert | Schema v2 (`problem`+`solution`), Migration alter Sitzungen beim Laden | |
| 2 | `src/startup_voice/features/interview/prompts.py` | geändert | Fragehinweise für `product.problem` / `product.solution` | |
| 2 | `src/startup_voice/web.py` | geändert | Router, `ido` als UI-Feature, Frame-Richtlinie (`frame-ancestors`) | |
| 2 | `src/startup_voice/static/app.js` | geändert | Brücke erzeugen/starten, bei Zustandsänderung melden | |
| 2 | `tests/test_ido_delta.py`, `tests/js/ido-bridge.test.mjs` | neu | Delta, Endpoint, Frame-Richtlinie, Brücke | grün |
| 2 | `tests/test_pipeline.py`, `tests/test_idoo_five_turn.py` | geändert | Fixtures auf vier Produktfelder | grün |
| 2 | `docs/ido-journey/validate_map.py`, `tests/test_ido_journey_map.py` | geändert | liest Vertrag aus dem Paket, prüft ido-Zulassungsliste (+3 Tests) | 17 grün |
| 2 | `.env.example`, `README.md`, `docs/ido-journey/PLAN.md`, `docs/ido-journey/files.md` | geändert | `IDO_ORIGINS`, Abschnitt „Running inside ido-core“, Phase-2-Stand | |

## Phase 2 in ido-core (nicht committet)

| Phase | Datei | Art | Zweck | Status |
|---|---|---|---|---|
| 2 | `src/lib/intake-bridge/protocol.ts` | neu | Protokoll, Zulassungsliste `INTAKE_FIELD_KEYS`, `parseIntakeMessage` | 9 Tests, tsc strict |
| 2 | `src/lib/intake-bridge/applyDelta.ts` | neu | Regel 3 („nur Lücken füllen“), rein | 14 Tests, tsc strict |
| 2 | `src/lib/intake-bridge/adapter.ts` | neu | bindet an `getVentureView` / `setFieldValue` (Origin `voice_intake`, kein Status) | nur Syntax |
| 2 | `src/lib/intake-bridge/protocol.test.ts`, `applyDelta.test.ts` | neu | 23 vitest-Tests, vier absichtliche Brüche belegt | grün (temporäre Installation) |
| 2 | `src/components/intake/IntakeView.tsx` | neu | iframe + Message-Handler | **nur Syntax, nicht gerendert** |
| 2 | `src/components/IdeaPage.tsx` | geändert | Tab „Interview“ in beiden Shells, nur bei gesetzter URL sichtbar | **nur Syntax** |
| 2 | `src/components/IdeaPage.shells.test.tsx` | geändert | `intake` in `CONTENT_TABS` + Mock | **nicht ausgeführt** |
| 2 | `.env.local.example` | geändert | `VITE_VOICE_INTAKE_URL` | |

## Phase 1 in ido-core (`~/Desktop/GigiApps/ido-app/ido-core`, Branch `feature/idea-tasks`, **nicht committet**)

| Phase | Datei | Art | Zweck | Status |
|---|---|---|---|---|
| 1 | `supabase/migrations/venture_voice_intake.sql` | neu | Origin `voice_intake` + Feld `funding` (Step 63) | auf Postgres 14 geprüft |
| 1 | `supabase/migrations/APPLY_ORDER.md` | geändert | Zeile + Hinweis zu Step 63 | |
| 1 | `src/types/venture.ts` | geändert | `VentureChangeOrigin` + `'voice_intake'` | |
| 1 | `src/services/ventureFields.ts` | geändert | Label „Voice intake“ | |
| 1 | `src/services/ventureOrigins.test.ts` | neu | Drift-Wächter SQL-CHECK ↔ Union ↔ Labels | 5 Tests, rot bei Brüchen belegt |
| 1 | `docs/architecture/venture-data-model.md` | geändert | 17 Felder, Zeile `funding` | |

## Geplant (noch nicht angelegt)

| Phase | Datei | Repo | Zweck |
|---|---|---|---|
| 3 | `src/services/intakePlacement.ts` | ido-core | Dossier → `PlacementAnswers` |
| 4 | `src/startup_voice/features/interview/gaps_from_ido.py` | voice-agent | `GAP_QUEUE` aus `venture_fields` |
