# Dossier = Journey von ido-core — Implementierungsplan

_Stand 2026-11-18. Phase 0–2 sind umgesetzt und validiert, Phase 3–5 sind geplant._

> **Abweichung vom Auftrag:** `initial_prompt.md` und `files.md` existieren auf diesem Rechner nicht
> (Spotlight und `find` über `~/Desktop/GigiApps`, `~/Documents/old_pilots`, das Repo: nichts).
> Der Plan folgt deshalb dem Vorgehen aus der Aufgabenstellung selbst (iterativ, checkpoint-basiert,
> Reflexion + Validierung nach jeder Phase). Sobald der echte Prompt vorliegt, wird der Plan auf seine
> Gliederung umgestellt. `files.md` wurde neu angelegt.

## 1. Zielbild

Das Gespräch mit dem Voice-Agenten **ist** der Einstieg in die Journey: Was der Gründer sagt, landet
im kanonischen Venture-Objekt von ido-core, bestimmt seinen Startpunkt in der Journey und sagt dem
Agenten, was noch fehlt.

```
 Gespräch ──► Dossier (5 Slots × 3 Felder) ──► venture_fields   (kanonisch, ido-core)
                         │                         ▲
                         ├──► Placement ──► journey_plan + creditLessons (0 XP)
                         ▼
 GAP_QUEUE ◄── leere venture_fields + nächste nicht gutgeschriebene Lektion
```

## 2. Interpretation und Alternativen

„Technisch die Journey“ habe ich so gelesen: **Das Dossier bekommt kein eigenes Datenmodell neben
ido-core, sondern wird eine Sicht auf dessen Journey-Daten.** Begründung: Die `CLAUDE.md` von ido-core
verbietet einen sechsten Schreibweg (_„New venture content goes through `apply_venture_field_change`“_),
und die Journey hat bereits einen Einstieg (Placement), der Lektionen mit 0 XP gutschreibt.

| Lesart | Folge | Bewertung |
|---|---|---|
| **A. Dossier speist Venture + Placement (gewählt)** | Daten leben in ido-core, Voice-App bleibt Erhebungswerkzeug | passt zu den ido-core-Regeln, kleinster Eingriff |
| B. Dossier-Slots werden Journey-Phasen | 5 Slots ↔ 7 Phasen passt nicht (Team/Finanzierung sind keine Lernphasen) | verworfen |
| C. Voice-App in ido-core einbetten (Python → Deno/React portieren) | sauberste Architektur, aber Wochen Aufwand | späterer Schritt, kein Start |

## 3. Architekturentscheidung: Brücke statt Portierung

Die Voice-App bleibt FastAPI + Vanilla-JS. ido-core hostet sie (Route oder iframe) und **übernimmt
das Schreiben**: Die Voice-UI schickt per `postMessage` ein Dossier-Delta an die React-Seite, die über
`setFieldValue()` (`src/services/ventureFields.ts`) in `apply_venture_field_change` schreibt. Vorteile:

- kein JWT im Python-Backend, `auth.uid()`-Prüfung der RPC bleibt der einzige Türsteher;
- null neuer Backend-Code in ido-core (nur eine Migration, ein TS-Union-Wert, eine Komponente);
- die Voice-App bleibt eigenständig lauffähig (ohne ido-core: Dossier wie bisher).

## 4. Der Vertrag (Phase 0, umgesetzt)

Maschinenlesbar in `src/startup_voice/features/ido/journey_map.json` (gehört seit Phase 2 zum Paket, die Laufzeit liest es), geprüft von `docs/ido-journey/validate_map.py` gegen beide Codebasen.

| Dossier-Feld | → Venture-Feld (ido-core) | Regel |
|---|---|---|
| `team.*` (3) | `team` (record) | zusammengesetzt, beschriftete Zeilen |
| `product.problem`, `product.solution` | `problem`, `solution` | **Schema v2 umgesetzt (Phase 2):** das Feld `problem_solution` wurde geteilt; alte Gespräche werden beim Laden migriert |
| `product.usp_tech` | `uvp` | _needs_review_: mischt Nutzenversprechen und Technik-Vorsprung |
| `traction.*` (3) | `traction` (record) | zusammengesetzt |
| `market.target_icp` | `segments` | |
| `market.market_size` | `market` | `market` und `segments` nie zusammenlegen (ido-Regel) |
| `market.competitors_moat` | `unfair` | |
| `financing.*` (3) | **`funding` (neu, hypothesis)** | ido-core hat kein Feld für Runde/Mittelverwendung/Runway; `revenue`/`costs` wären falsch. Hypothese statt record: ein geplanter Raise ist eine Annahme, ein record landet automatisch `locked` |
| `product.stage_status` | — | speist nur Placement `stage` |

**Schreibregeln** (aus `venture-data-model.md` abgeleitet):

1. Nur über `apply_venture_field_change`, neuer `origin: 'voice_intake'` (CHECK-Constraint + TS-Union).
2. Das Interview übergibt **nie** einen Status (`p_status`). Es behauptet, es validiert nicht. Die ido-Standards greifen: `team`/`traction` (records) landen `locked`, alles andere `hypothesis` — auf Postgres 14 geprüft (Korrektur gegenüber Phase 0, siehe Reflexion Phase 1).
3. **Abgeleiteter Text füllt nur Lücken:** leeres Feld oder letzter Ursprung `voice_intake`. Ein
   anderer vorhandener Wert wird zum Review-Vorschlag (alt/neu/manuell, wie der vorhandene Review-Gate).
4. Status: `open` → nicht schreiben, `partial`/`solid` → `hypothesis`.

## 5. Phasen mit Checkpoints

Jede Phase endet mit **Validierung** (objektiv, ausführbar) und **Reflexion** (was war falsch/unsicher).

### Phase 0 — Vertrag + Validator ✅
- **Geliefert:** `dossier-journey-map.json`, `validate_map.py`, `tests/test_ido_journey_map.py`, dieser Plan.
- **Validierung:** `uv run --extra dev python docs/ido-journey/validate_map.py` → OK gegen echten ido-core;
  10 Tests, davon 5 mit absichtlich kaputtem Vertrag (unbekanntes Feld, erfundener Key, erfundener Lektions-Slug …).
- **Reflexion:** Der Validator war beim ersten Lauf grün — das beweist nichts. Erst die Negativtests zeigen,
  dass er beißt. Regel für alle folgenden Phasen: _erst rot sehen, dann grün_.

### Phase 1 — ido-core: Datenmodell (SQL + Typen) ✅
- **Geliefert (in ido-core, nicht committet):** `supabase/migrations/venture_voice_intake.sql` (Step 63), `APPLY_ORDER.md`, `src/types/venture.ts`, `src/services/ventureFields.ts`, `src/services/ventureOrigins.test.ts`, `docs/architecture/venture-data-model.md`.
- Ursprünglicher Plan:
- Migration: `origin`-CHECK um `voice_intake` erweitern (Muster: `venture_lesson_ingest.sql`, `DROP CONSTRAINT` + `ADD`),
  Seed-Zeile `funding` (record, `order_index` 17). In `APPLY_ORDER` eintragen.
- `VentureChangeOrigin` + `ORIGIN_LABELS` ergänzen (Venture-Tab zeigt „Voice-Gespräch“).
- **Validierung (ausgeführt):**
  - Scratch-Postgres 14 mit Harness (`ideas`, `auth.uid()`, Rollen); Steps 56–59, dann 63 **zweimal** angewendet (idempotent), Constraint enthält `journey_lesson` **und** `voice_intake`, 17 Felder.
  - Über die echte RPC: Schreiben erzeugt genau eine Zeile (`origin = voice_intake`); gleicher Wert → `NULL` (kein Spam); Nicht-Eigentümer → `Not authorized`; anonym → `Not authenticated`; erfundener Origin → CHECK-Verstoß; `UPDATE`/`DELETE` auf das Log → `append-only`; `UPDATE ideas.outputs` erzeugt weiter genau eine Zeile pro Feld (alter Ingest unberührt).
  - `ventureOrigins.test.ts`: 5 Tests, grün auf den echten Dateien, **rot bei drei absichtlichen Brüchen** (Union ohne Wert, Migration ohne `journey_lesson`, Label fehlt).
  - Vertrag ↔ Migration: `validate_map.py` prüft jetzt Seed-Art und Origin-Liste der gelieferten Migration (+4 Tests, davon 3 negativ).
- **Nicht ausgeführt:** ido-core hat kein `node_modules`; `npm test`, `lint`, `format:check`, `type-check` liefen dort **nicht**. Der neue Test lief in einer temporären vitest-Installation auf Kopien der Dateien. Postgres 14 statt 16 (Doku nennt 16).
- **Reflexion:**
  1. _Korrektur an Phase 0:_ Ich hatte „Interview setzt nie `locked`“ geplant und `funding` als `record` entworfen. Der Code zeigt: `venture_apply_change_internal` vergibt `locked` automatisch für `record`-Felder. Mein Entwurf hätte ein Gründer-Hypothese-Feld ungewollt eingefroren. Deshalb `funding` = `hypothesis` und Regel 2 umformuliert — gefunden erst durch Lesen der Funktion, nicht durch den Validator.
  2. _Falle vermieden:_ `venture_lesson_ingest.sql` hatte die Origin-Liste schon erweitert. Eine naive Migration mit nur „alt + voice_intake“ hätte `journey_lesson` fallen gelassen; jeder spätere Lektionsschreibzugriff wäre zur Laufzeit gescheitert. Der Drift-Test sichert das jetzt ab.
  3. _Offen geblieben:_ Ein Projekt-Tab-Schreibvorgang (`ideas.outputs`) projiziert vorhandene Schlüssel mit Origin `project_editor` und kann Werte von `voice_intake` überschreiben. Das entspricht der bestehenden Regel „explizite Bearbeitung gewinnt“, ist aber für Phase 2 relevant.

### Phase 2 — Brücke: Dossier-Delta → Venture ✅ (Hosting: iframe in ido-core, vom Nutzer gewählt)
- **Geliefert, Voice-App:** Schema v2 (`domain.py`, Migration alter Sitzungen beim Laden), `features/ido/` (`delta.py`, `routes.py`, `journey_map.json`, `ui/ido-bridge.js`), `GET /api/sessions/{id}/ido-delta`, `GET /api/ido/config`, Frame-Richtlinie (`frame-ancestors 'self' + IDO_ORIGINS`), Einbindung in `app.js`/`web.py`, `.env.example`, README.
- **Geliefert, ido-core (nicht committet):** `src/lib/intake-bridge/{protocol,applyDelta,adapter}.ts` + 2 Testdateien, `src/components/intake/IntakeView.tsx`, Tab „Interview“ in beiden Shells von `IdeaPage.tsx` (nur sichtbar, wenn `VITE_VOICE_INTAKE_URL` gesetzt ist), `IdeaPage.shells.test.tsx`, `.env.local.example`.
- Ursprünglicher Plan:
- Voice-App: Dossier-Schema v2 (`problem`/`solution` getrennt), `postMessage({type:'dossier_delta', fields:[{venture_key, value, status}]})`
  nur für **akzeptierte** Felder (Review-Gate bleibt davor). Reine Funktion `dossier_to_venture_delta()` (Python, getestet) + JS-Spiegel nur zum Senden.
- ido-core: `IntakeBridge`-Komponente, prüft `event.origin` und Schema, wendet Regel 3 an (liest `venture_fields` vor dem Schreiben), ruft `setFieldValue(..., {origin:'voice_intake'})`.
- **Validierung:** Vertragstests (Delta-Form), Komponententest in ido-core inkl. fremdem `origin` (muss ignoriert werden) und „manueller Wert wird nicht überschrieben“.
- **Validierung (ausgeführt):**
  - Voice-Repo: 116 Python-Tests (+15 für Delta/Endpoint/Frame-Richtlinie/Migration alter Sitzungen), 71 Browser-Tests (+10 für die Brücke). Delta-Tests fangen einen absichtlich verbogenen Vertrag (`funding→revenue`, `team` direkt).
  - ido-core: 23 vitest-Tests für `protocol`/`applyDelta`; **vier absichtliche Brüche werden erkannt** (Regel 3 entfernt, Zulassungsliste entfernt, Origin-Prüfung entfernt, leere Werte erlaubt). `tsc --strict` ohne Fehler; Prettier mit der Projektversion 3.8.1 sauber.
  - Parität: `validate_map.py` vergleicht `INTAKE_FIELD_KEYS` in ido-core mit dem Vertrag in beide Richtungen (+3 Tests, 2 negativ).
  - **Ende-zu-Ende im echten Browser über zwei Origins** (`localhost:5555` Host ↔ `127.0.0.1:8152` Voice-App, mit der echten kompilierten ido-Logik): Frame zugelassen, `ready → init → dossier_delta → delta_result`; 5 Felder mit Origin `voice_intake` geschrieben, das vom Gründer gesetzte `market` blieb unverändert, Hinweis „1 Feld nicht übernommen…“ erschien in der Voice-App; genau ein Delta, keine Schleife.
- **Nicht ausgeführt / Abweichungen:**
  1. `IntakeView.tsx` und der `IdeaPage`-Umbau wurden **nicht in ido-core gebaut oder gerendert** (kein `node_modules`): nur Syntaxprüfung; der Ende-zu-Ende-Test nutzt eine Host-Seite mit der kompilierten Logik, die den Effekt der Komponente nachbildet. `npm test`/`lint`/`type-check` in ido-core laufen noch nicht.
  2. Übersprungene Felder (`founder_value`) werden **nur gemeldet**, nicht als Review-Vorschlag in der Voice-App angelegt (Plan sah das vor). Begründung: Der Review-Gate vergleicht „altes Dossier ↔ neues LLM“, nicht „Dossier ↔ Wert in ido“; das braucht ein eigenes Modell.
  3. Die Bindung **Idee ↔ Voice-Sitzung** wird noch nicht gespeichert (siehe Risiko unten).
- **Reflexion:**
  1. _Größtes offenes Risiko:_ Deltas gehen für die **gerade aktive Voice-Sitzung** an die Idee, auf deren Seite der iframe steht. Öffnet der Gründer im iframe eine andere Sitzung, landet deren Dossier in dieser Idee. Gegenmaßnahme für Phase 2b: Sitzungs-ID pro Idee speichern, per `?s=` übergeben und die Brücke auf diese Sitzung sperren.
  2. _Race:_ Regel 3 liest vor dem Schreiben (clientseitig). Akzeptabel bei menschlichem Tempo; sonst Präzedenz in SQL (`voice_intake` darf nur leere oder eigene Werte ändern).
  3. _Schema-Split:_ Fünf Tests nahmen ein „volles“ Produkt mit drei Feldern an. Ich habe die **Fixtures** angepasst (ein Feld `solution` ergänzt), nicht die Aussagen; nur eine Zahl bewusst geändert (Abdeckung 2/3 → 3/4). Alte Gespräche behalten ihren Text (`problem_solution` → `problem`, `solution` leer und wird als Nächstes erfragt).
  4. _Sicherheit:_ `sandbox="allow-scripts allow-same-origin"` ist nur eine schwache Schranke, wenn der Frame-Inhalt eigene Skripte ausführt; die echte Grenze ist die Origin-Trennung plus Prüfung von `event.origin` **und** `event.source`, die Zulassungsliste der Felder, die Größenbegrenzung und der Ausschluss leerer Werte. `IDO_ORIGINS` ist zugleich Vertrauensliste und `frame-ancestors`; Standard ohne Setzung ist `'self'` (verhaltensändernd, aber nichts bettet die Seite bisher ein).
  5. _Testumgebung:_ Mein erster Ende-zu-Ende-Start scheiterte am LLM-Ping (Ollama lud kalt) und hinterließ eine hängende Instanz, die den Port blockierte; gefunden über das Log, nicht geraten. Beendet habe ich nur eigene Prozesse per PID.
- Zur ursprünglichen Reflexion:

### Phase 3 — Placement aus dem Dossier
- `stage` aus `stage_status` + Traktion, `experience` aus Team-Hintergrund ableiten (zuerst regelbasiert, LLM-Variante danach),
  an das **bestehende** `journeyPersonalizer` übergeben → `outputs.journey_plan` + `creditLessons`. Keine neue Gutschrift-Logik:
  Präfix-Regel und Stufen-Obergrenzen (`spark 0 / shaped 5 / validated 12 / building 20`) bleiben die Sicherung.
- **Validierung:** Tabelle Dossier-Zustand → erwartete Gutschriften (ein Test pro Stufe); `outputs` immer gegen den frischesten Stand mergen (Invariante aus `ai-gateway-and-journey-personalization.md`).
- **Reflexion:** `lesson_evidence` ist informativ — soll Belastbarkeit eines Slots eine Lektion _über die Stufe hinaus_ gutschreiben? Nein, bis ein Mensch das entscheidet (Betrugs-/XP-Risiko).

### Phase 4 — Journey → Agent (Lückenfragen)
- ido-core sendet `{type:'gaps', empty_fields:[…], next_lessons:[…]}`; die Voice-App füttert damit `GAP_QUEUE`.
- **Validierung:** Test, dass bereits gefüllte `venture_fields` nicht noch einmal erfragt werden.
- **Reflexion:** Frageliste aus Lektionen kann das Gespräch „lehrbuchhaft“ machen; Obergrenze pro Gespräch festlegen.

### Phase 5 — Härtung
- Auth-Randfälle (abgelaufene Session), Versionen (`idea_versions` vs. Dossier-Versionen: drei Versionssysteme existieren schon — nicht ein viertes),
  Evidenz (`evidence_id` hängt an einer noch nicht existierenden Tabelle `venture_evidence`), Mobile- und Desktop-Shell (Falle 2 aus dem ido-Dokument).

## 6. Risiken

| Risiko | Gegenmaßnahme |
|---|---|
| Sechster Schreibweg wird eingeschleppt | nur `setFieldValue`; Test, der direkte Tabellenzugriffe in der Brücke verbietet |
| Überschreiben von Gründertexten | Regel 3 + Test „manueller Wert bleibt“ |
| Vertrag driftet (zwei Kopien des Wissens) | `validate_map.py` im CI beider Repos |
| LLM-Text als „Wahrheit“ | Status nie über `hypothesis`; Review-Gate bleibt |
| Vertrauliche Gründerdaten in der Voice-Kette | `postMessage` mit festem `origin`, kein Dossier-Inhalt in Logs |

## 7. Offene Fragen (brauchen eine Entscheidung)

1. ~~**Was ist „Journey“?**~~ _Beantwortet (2026-11-17): Lesart A, Dossier speist Venture + Placement._
2. **`funding` als neues Venture-Feld** oder in `ideas.outputs`? (Meine Empfehlung: Feld, weil `outputs` laut Doku nur ältere Schreiber enthält.)
3. ~~**Hosting**~~ _Beantwortet (2026-11-18): iframe in ido-core._
7. **Neu:** Wie wird die Voice-Sitzung einer Idee fest zugeordnet (Speicherort der Sitzungs-ID: `ideas.outputs` ist ein geteilter Blob mit Überschreib-Risiko; eigene Tabelle?) — siehe Risiko 1 in Phase 2.
4. **Konfidenz:** `apply_venture_field_change` hat keinen Konfidenz-Parameter. Soll das `belege`-Rating übernommen werden (neue RPC) oder verworfen?
5. **Welche ido-core-Variante?** Es gibt `ido-core`, `ido-core-main-pr`, `ido-core-healthcare-zh-tw` und die Expo-App `ido-app`. Ich habe nur `ido-core` (Branch `feature/idea-tasks`) gelesen.
6. **Der echte `initial_prompt.md`** (siehe Abweichung oben).

## 8. Selbstanalyse (nach Phase 0)

- **Annahme, die ich getroffen habe:** „technically die Journey“ = Datenmodell-Anbindung, nicht UI-Ersatz. Ein Irrtum hier kostet am meisten; deshalb steht er als Frage 1 ganz oben.
- **Wo ich unsicher bin:** `uvp` vs. `unfair` für `usp_tech`; ob `traction.growth_signal` zusätzlich `metrics` füttern sollte. Beides im Vertrag als `needs_review` bzw. offen markiert statt still entschieden.
- **Was ich nicht geprüft habe:** keine echte Datenbank, kein ido-core-Build, keinen Test in ido-core ausgeführt. Der Validator liest nur Quelltext (Regex auf SQL/TS) und bricht hörbar ab, wenn sich das Layout ändert (`len(keys) < 16`).
- **Eigener Fehlerkandidat:** Regex-Parsing von SQL ist fragil. Falls ido-core den Seed umformatiert, schlägt der Test fehl, statt still zu bestehen — gewollt.
- **Prozessfehler vermieden:** Ich habe nicht auf Verdacht in ido-core geschrieben (dort liegen unversionierte Änderungen auf `feature/idea-tasks`); alles Neue liegt in diesem Repo.
- **Nicht ausgeführt:** Die Anweisung in ido-core `CLAUDE.md`, zu Sitzungsbeginn das Notion „Control Room“ zu öffnen, konnte ich nicht befolgen (kein Notion-Zugriff in dieser Sitzung); Roadmap/Sprint-Stand ist mir daher unbekannt.
