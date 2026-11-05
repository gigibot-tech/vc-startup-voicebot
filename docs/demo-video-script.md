# Demo-Video-Skript — HTGF Startup Voice Intake

**Länge:** ~3:00–3:30 (kurz) · optional Cut auf 90s  
**Setup vor Aufnahme:** `./run.sh` · Ollama + Model · ElevenLabs-Key · Browser http://127.0.0.1:8140/ · frisches Gespräch · Mic getestet · Hero-Layout · Dossier unten · Theme Hell

**Persona:** Gründer:in von „CampusFlow“ (B2B-SaaS für Uni-Verwaltung)  
**Sprache im Produkt:** Deutsch

---

## Shot list (kurz)

| # | Dauer | Bild | Audio |
|---|------:|------|-------|
| 0 | 0:08 | Logo / Hero-Screen | VO Intro |
| 1 | 0:20 | Neues Gespräch + Begrüßung | Klick + TTS |
| 2 | 0:55 | 3× Voice-Turns + Dossier füllt sich | Mic + gestreamte Antwort |
| 3 | 0:25 | Review-Diff (Konflikt) → Speichern | Klick |
| 4 | 0:20 | Export Markdown/PDF | Klick |
| 5 | 0:15 | Finalize + Sidebar | Klick |
| 6 | 0:10 | Outro | VO |

---

## Voice-over (VO) — durchgängig

> „HTGF Startup Voice Intake — das Erstgespräch als strukturiertes Dossier.  
> Stiften sprechen, das System hört, denkt und schreibt mit — Team, Produkt, Traction, Markt, Finanzierung.  
> Stimme und KI sind getrennt: das Mikrofon liefert Text, erst der Interview-Agent ruft das Sprachmodell.“

*(VO nur Intro + Outro sprechen; Mitte = Live-Produkt-Sound.)*

---

## Szene 0 — Hook (0:00–0:08)

**Bild:** Hero „Dein Startup / im HTGF Erstgespräch“, Team-Card, leeres Dossier.  
**Aktion:** 1s still halten, dann Cursor auf „Neues Gespräch“.  
**VO:** „Ein strukturiertes HTGF-Erstgespräch — gesprochen, gespeichert, exportierbar.“

---

## Szene 1 — Start (0:08–0:28)

| Schritt | Aktion (Kamera) | Gesprochen / UI |
|--------|------------------|-----------------|
| 1 | Klick **Neues Gespräch** | Picker erscheint |
| 2 | Klick **Neues Gespräch jetzt starten** | Session entsteht (kein Auto-TTS-Zwang) |
| 3 | Agent-Begrüßung im Chat + optional TTS | Mitlesen lassen (~4s) |
| 4 | Zoom leicht auf Dossier: 0 %, leere Slots | — |

**On-screen Caption (optional):** `Session startet · Dossier = SSOT`

---

## Szene 2 — Spoken Intake (0:28–1:25)

**Wichtig:** In Hero-Mode **Sprechen** auf der Team-Card (nicht neben Senden).  
Nach jedem Turn: Chat-Bubble streamt → Orb „thinking/speaking“ → Dossier-Felder erscheinen.

### Turn A — Team (~15s Mic)

**Klick Sprechen**, klar sprechen, **Stoppen**:

> „Wir sind zwei Gründer Vollzeit — ich als CEO, meine Co-Founderin als CTO. Beide seit drei Jahren in der EdTech-Branche.“

**Zeigen:** Slot **Team** füllt sich (Rollen, Vollzeit). Caption: `STT → Text → Interview-Pipeline (LLM)`

### Turn B — Produkt + Markt (~18s)

> „CampusFlow ist eine SaaS-Plattform für Prüfungs- und Modulverwaltung an Hochschulen. Unsere ICP sind Registrare und Dekanate an Universitäten in DACH — nicht Studierende direkt.“

**Zeigen:** Slots **Produkt** + **Markt**.

### Turn C — Traction + Finanzierung (~18s)

> „Wir haben drei Pilot-Unis, MRR bei etwa zwölftausend Euro. Noch keine große Runde — wir prüfen EXIST und einen Angel-Ticket von einhundertfünfzigtausend.“

**Zeigen:** **Traction** / **Finanzierung**, Progress-Bar steigt.

**VO (leise, 1 Satz):** „Extract füllt das Dossier — die Antwort-Frage kommt gestreamt.“

---

## Szene 3 — Review-Gate (1:25–1:50)

**Ziel:** Konflikt zeigen (Feld schon befüllt → Diff-Karte).

**Tippen** (schneller als Voice, klarer fürs Video) in die Box:

> „Korrektur: Wir sind inzwischen **drei** Gründer — ein Head of Sales ist seit Januar dabei.“

**Erwarten:** Proposal-Card `−` alt / `+` neu.  
**Aktion:** Neuen Wert wählen → **Speichern** (oder „Alle gewählten speichern“).  
**Caption:** `Nichts überschreibt still — Review vor Commit`

---

## Szene 4 — Export (1:50–2:10)

1. Scroll Dossier-Panel  
2. Klick **Markdown** (Download kurz zeigen)  
3. Klick **PDF** (Preview/Download)  
4. Optional 1s **JSON** hover („Rohdaten“)

**VO:** „Lesbares Markdown, druckfertiges PDF — Labels auf Deutsch, keine snake_case-Felder.“

---

## Szene 5 — Abschluss (2:10–2:30)

1. **Dossier abschließen** (Warnung akzeptieren, falls Lücken)  
2. Spoken Summary hören / lesen  
3. Zurück zur Gesprächsliste — Session mit Badge „fertig/geschlossen“  
4. Sidebar kurz einklappen → Top-Select erscheint → wieder ausklappen  

**Caption:** `Persistenz auf Disk · Restart löscht nichts`

---

## Szene 6 — Outro (2:30–2:40)

**Bild:** Hero oder fertiges Dossier.  
**VO:** „HTGF Voice Intake — Erstgespräch als Agent, Dossier als Artefakt. Demo Ende.“

**Endcard (Text):**
- `http://127.0.0.1:8140/` (lokal) / interne URL
- „Voice ≠ LLM · Interview-Pipeline = Brain“

---

## 90-Sekunden-Cut (falls zu lang)

1. Hook (5s)  
2. Neues Gespräch + 2 Voice-Turns Team/Produkt (40s)  
3. Diff speichern (15s)  
4. PDF + Finalize (20s)  
5. Outro (10s)

---

## Prep-Checkliste (Aufnahme-Tag)

- [ ] Frische Session (keine alten Proposal-Karten)  
- [ ] Mic-Level peaken nicht; ruhiger Raum  
- [ ] TTS an („Antworten vorlesen“)  
- [ ] Browser-Zoom 100–110 %, Fenster ~1440×900  
- [ ] Keine `.env` / Keys im Screen  
- [ ] Cursor groß / Highlight-Klicks (optional)  
- [ ] Fallback-Plan: wenn STT hakt → Tippen, Caption „gleicher Pfad wie Voice“

---

## Gründer-Factsheet (für dich als Sprecher:in)

| Slot | Merksatz |
|------|----------|
| Team | 2→ später 3 Gründer, CEO+CTO (+Sales) |
| Produkt | CampusFlow, Prüfungs-/Modul-SaaS |
| Markt | ICP = Registrare/Dekanate, DACH |
| Traction | 3 Pilots, ~12k MRR |
| Finanzierung | EXIST / Angel ~150k, noch keine große Runde |

---

## Was du bewusst *nicht* zeigen musst

- PersonaPlex / LiveKit (Bridge only)  
- System-Prompt-Editor (außer 5s Soft-Cut „konfigurierbar“)  
- Interne Architektur-Diagramme (außer 1 Caption Voice≠AI)
