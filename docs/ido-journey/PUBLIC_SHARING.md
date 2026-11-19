# Dossier auf dem Board, öffentlich teilen, Besitzer-Nachweis, DSGVO

_Stand 2026-11-19 (später). Punkt 0, 1 und 2 sind gebaut. **Der öffentliche Idea Board ist in der Voice-App gebaut** (`/board`, `/d/<link>`, Dialog „Öffentlich teilen…“, Besitzer-Schlüssel; Entscheidung des Nutzers: in `startup-voice-agent`, im Look der Marketingseite, Listung nur mit eigener Einwilligung). Die ido-core-Variante von Punkt 2 (`/d/:slug` mit Konto) existiert parallel; die beiden sind noch nicht zusammengeführt._
_**Offen vor einem echten Livegang des Boards:** Sitzungs-Isolation pro Besucher (heute kann jeder Besucher jedes Gespräch öffnen), Rechtsprüfung der Einwilligungstexte, Bestätigungs-Mail für die optionale E-Mail, Moderationsansicht für Meldungen, Aufbewahrungsfrist._
_Die Marketingseite (`ido-marketing`, Next.js) liegt nicht auf diesem Rechner (`/Users/yanmcruz/ido-marketing`, kein Git-Remote); der Look wurde von der Live-Seite abgelesen (Farben, Karten, Buttons)._

_Entschieden: Board zuerst; Besitzer-Nachweis später = Schlüssel + optionale E-Mail._
_Das ist technische Planung, **keine Rechtsberatung**: Alles unter „DSGVO“ gehört vor dem Livegang
durch eine Datenschutzbeauftragte bzw. einen Anwalt geprüft._

## Was „Phase 2b“ und „Phase 3“ bedeuten (in einfachen Worten)

| Name | Was es ist | Priorität |
|---|---|---|
| **2b** | Das Interview wird fest **einer** Idee im Konto zugeordnet, damit ein Dossier nicht in der falschen Idee landet. | niedrig: Du hast recht, dass die Idee ohnehin am Konto hängt. Es bleibt nur das Risiko „falsche Idee desselben Kontos“. |
| **3** | Aus dem Interview wird der **Startpunkt in der Journey** abgeleitet (bereits Gekonntes wird gutgeschrieben, ohne XP). | niedrig, kommt nach Board und Teilen |

## Neue Reihenfolge

| # | Was | Warum zuerst |
|---|---|---|
| **0** ✅ | Live-Modus erkennbar machen; App startet morgens zuverlässig | du konntest die zwei Sprechmodi nicht unterscheiden |
| **1** ✅ | Dossier → **Notizen auf dem Board** der Idee (mit Konto) | beantwortet „speichert es?“; kleinster Schritt, nutzt vorhandene Notizen |
| **2** ✅ | Dossier **teilen** (mit Konto) auf einer eigenen öffentlichen Seite `/d/:slug` | **Abweichung vom Entwurf:** nicht `/p/:slug`, siehe unten |
| **3** | **Anonym** auf der Homepage nutzen + Besitzer-Nachweis | größter Aufwand und größtes Datenschutzrisiko: erst nach Punkt 1 und 2 und nach Rechtsprüfung |
| später | 2b, Placement | |

## 1. Dossier → Board ✅ (gebaut)

**Umsetzung:** bis zu fünf Karten (Team, Product, Traction, Market, Financing), Titel von ido-core, Fußzeile mit Prüfsumme. Eine **vom Gründer bearbeitete Karte wird nie überschrieben und nie dupliziert**; eine unveränderte Karte wird an Ort und Stelle aktualisiert. Details und Regeln: `docs/features/voice-intake.md` in ido-core. Im Browser über zwei Origins geprüft: Karten angelegt, Neuladen erzeugt keine Duplikate, Dossier-Änderung aktualisiert dieselbe Karte, eine Gründer-Karte mit gleichem Titel bleibt unangetastet.

_Ursprünglicher Entwurf:_

ido hat pro Idee ein Notizboard (`idea_notes`, Reiter „Notes“; Schreiben über `createNote`, Aktualisieren
erlaubt die bestehende RLS-Regel „Idea members update notes“, es fehlt nur eine Hilfsfunktion `updateNote`).

**Vorschlag (eine Notiz pro Bereich, bis zu fünf Karten):**

```
Interview · Team
Gründer & Rollen: Anna (CEO), Ben (CTO)
Hintergrund & Expertise: …
Zeitliche Verfügbarkeit: Beide Vollzeit
```

- Titelzeile `Interview · <Bereich>` dient auch als Kennung: Beim nächsten Stand wird **dieselbe** Karte
  aktualisiert, nicht eine neue angelegt (sonst Karten-Spam bei jeder Antwort).
- Nur Bereiche mit Inhalt; keine Belege/Zitate und kein Gesprächsverlauf in den Karten.
- Der Weg ist derselbe wie bei den Venture-Feldern: `postMessage` aus dem iframe, Schreiben mit der
  Sitzung des Gründers, Zulassungsliste, Größenbegrenzung, „was der Gründer selbst geändert hat, bleibt“
  (hier: Karte ohne Interview-Titelzeile wird nie angefasst).
- **Heute gespeichert wird:** Wenn du in der Voice-App sprichst, landet alles **nur lokal** in
  `data/sessions/<id>/` (Gespräch + Dossier-Versionen). Nach ido kommt noch nichts: In ido-core ist
  `VITE_VOICE_INTAKE_URL` nicht gesetzt (kein Reiter „Interview“), und die Brücke schreibt bisher nur in
  die Venture-Felder, nicht auf das Board.

## 2. Öffentlich teilen (mit Konto) ✅ (gebaut, ido-core)

**Umsetzung und Abweichung:** Statt der vorhandenen Seite `/p/:slug` gibt es `/d/:slug` mit einer eigenen Tabelle `idea_public_dossiers`. Gründe: (1) die anonyme Leseregel von `ideas` legt die **ganze Zeile** offen, die neue Tabelle nur den veröffentlichten Text; (2) ein Schreiben in `ideas.outputs` würde den Venture-Import auslösen und Canvas-Texte überschreiben können. Das Veröffentlichen ist ein **Schnappschuss** (spätere Änderungen bleiben privat), nur der Hauptbesitzer darf, `team` lehnt die **Datenbank** ab, Zurückziehen **löscht den Text**, Einwilligung (Version + Zeitpunkt) wird gespeichert, die Seite hat `noindex` und keine Auflistung. Auf einer echten Postgres 14 geprüft (Missbrauchsfälle: anonym, Fremder, Team, leer, zu lang, falscher Typ, Direktschreiben, Slug-Stabilität, weiche Löschung, Kaskade). **Die Einwilligungstexte sind ein Entwurf und brauchen eine Rechtsprüfung.**

_Ursprünglicher Entwurf:_

ido hat: `ideas.slug`, `ideas.is_public`, die Seite `/p/:slug` (ohne Login lesbar), Abschnitte
`problem · market · solution · team · traction`.

Regeln, die ich vorschlage:

1. **Standard privat.** Teilen ist ein eigener, bewusster Schritt mit Schaltfläche und Hinweistext.
2. **Nur eine Auswahl (Positivliste)** wird veröffentlicht, nie das Gespräch, nie Belege/Zitate.
3. **`team` standardmäßig nicht veröffentlicht:** enthält Namen und Lebensläufe, auch von Mitgründern, die
   nie zugestimmt haben. Nur mit eigener Einwilligung pro Bereich.
4. Jederzeit **zurücknehmen** (Schalter), danach sofort nicht mehr abrufbar.
5. Auf der öffentlichen Seite: „Erstellt mit KI-Interview“, Meldeknopf, kein Tracking.

⚠ **Zu prüfen in ido-core:** Die Leseregel für anonyme Besucher lautet
`USING (is_public = true AND deleted_at IS NULL)`, also gilt sie für die **ganze Zeile**. Wenn `ideas`
Spalten wie `user_id` oder `owner_ids` enthält (ich habe die Spaltenliste nicht geprüft), sind diese für
jeden lesbar, sobald eine Idee öffentlich ist. Vor dem Livegang eine Ansicht (View) mit nur den
öffentlichen Spalten verwenden.

## 3. Anonym auf der Homepage + Besitzer-Nachweis

Hier gibt es **kein ido-Konto**, also keine Zuordnung über das Konto. Zwei Wege, du hast beide genannt:

| | **Besitzer-Schlüssel** (das geheime Passwort) | **E-Mail** |
|---|---|---|
| Wie | Beim Veröffentlichen erzeugt die Seite einen Zufalls-Schlüssel (mind. 128 Bit), zeigt ihn **einmal** an und speichert **nur den Hash** | E-Mail eingeben, Bestätigungslink (Double-Opt-in), dann ist sie der Besitzer |
| Daten | keine personenbezogenen Daten nötig | personenbezogenes Datum, braucht Einwilligung/Zweck |
| Verlust | Schlüssel weg = nur manuelle Klärung | Wiederherstellung per Mail möglich |
| „Mailt uns das Passwort“ | passt: Wer uns den Schlüssel schickt, beweist den Besitz (wir hashen und vergleichen) | passt nicht nötig |

**Empfehlung:** Schlüssel immer (datensparsam), E-Mail **optional** (nur für Wiederherstellung/Benachrichtigung,
mit Double-Opt-in). Mit dem Schlüssel kann man bearbeiten, zurücknehmen, löschen und seine Daten abrufen.
Löschwünsche über den Schlüssel sind Art. 17-Anfragen: Wir müssen innerhalb eines Monats reagieren.

Datenmodell (eigene kleine Tabelle, getrennt von ido-Konten):
`public_dossiers(id, slug, published_json, owner_key_hash, email_hash_or_null, consent_version, consent_at,
published_at, expires_at, unpublished_at)`; die Stimme/Rohdaten werden **nicht** gespeichert.

## DSGVO-Checkliste (technisch, zur Prüfung durch Fachleute)

| Thema | Stand im Code / Vorschlag |
|---|---|
| **Einwilligung** | Vor dem Interview: Zweck, Verantwortlicher, Empfänger, Speicherdauer, Rechte (Art. 13). **Getrennte** Einwilligung für das Veröffentlichen, widerrufbar. Version und Zeitpunkt speichern. |
| **Sprache / Audio** | Mit „Whisper (Browser)“ bleibt das Mikrofon im Browser. Mit ElevenLabs/Deepgram gehen Audiodaten an **US-Firmen** (Drittlandübertragung, Vertrag/AVV prüfen). Für den öffentlichen Modus: nur Browser-Whisper oder EU-Anbieter. Die Stimme des Analysten (ElevenLabs) bekommt nur den **Antworttext**, nicht das Gründer-Audio. |
| **LLM** | Lokal (Ollama) = keine Weitergabe. Scaleway/IONOS/STACKIT = EU, aber Auftragsverarbeitung klären. |
| **LiveKit** | Dein Projekt läuft in **Frankfurt**; Verbindungsdaten und Audio laufen durch LiveKit: AVV nötig. |
| **Gespeicherte Daten** | Heute liegen **Volltext des Gesprächs und Zitate** auf der Platte der Voice-App. Das muss löschbar sein (`store.delete` existiert) und eine Aufbewahrungsfrist haben (z. B. 90 Tage ohne Aktivität). |
| **Personen im Dossier** | `team` nennt Namen/Hintergründe, auch Dritter: eigene Warnung und Standard „nicht veröffentlichen“. |
| **Rechte** | Auskunft/Export und Löschung über den Besitzer-Schlüssel (Endpunkte bauen); Fristen einhalten. |
| **Missbrauch** | Öffentliche Inhalte brauchen Meldeknopf, Entfernen-Prozess, Ratenbegrenzung und Spam-Schutz. |
| **Tracking** | Voice-App nutzt keine Cookies, nur lokale Einstellungen. ido nutzt PostHog: Einwilligung dort (`lib/consent.ts` existiert). |
| **Dokumente** | Datenschutzerklärung, Verzeichnis der Verarbeitungstätigkeiten, Auftragsverarbeitungsverträge, ggf. Datenschutz-Folgenabschätzung. |

## Entscheidungen, die ich von dir brauche

1. Welche Reihenfolge: zuerst **Board** (Punkt 1) oder zuerst **öffentlich teilen** (Punkt 2)?
2. Besitzer-Nachweis für den anonymen Modus: nur Schlüssel, Schlüssel + optionale E-Mail (meine Empfehlung), oder E-Mail Pflicht?
3. Soll `team` je öffentlich werden dürfen (mit Einwilligung) oder nie?
