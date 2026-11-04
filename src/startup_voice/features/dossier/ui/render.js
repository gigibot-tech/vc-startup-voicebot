/**
 * Dossier feature (browser) - painting only. No network calls, no buttons wired here.
 *
 *   renderSlots(session)  slot cards + progress bar + export links + finalize button state
 *   dossierStats(session) {pct, filled, total, ready}  used by the cards AND by the finalize dialog
 *
 * "Ready" is decided by the SERVER (`session.evaluation.ready_for_closing`, see
 * features/dossier/scoring.py). The browser only counts filled fields for the % display.
 */

import { esc } from "../../shared/format.js";
import { fieldDisplayLabel, schema, slotBadgeLabel } from "./dossier-schema.js";

/** Below this field-fill %, "Dossier abschließen" asks for a stronger confirmation. */
export const WEAK_DOSSIER_PCT = 67;

/** [[fieldKey, text]] for one slot. If no field is set but a summary exists, it fills the 1st field. */
function fieldValues(obj) {
  const fields = (obj && obj.fields) || {};
  const keys = Object.keys(fields);
  const anyField = keys.some((k) => fields[k]);
  return keys.map((k, i) => [k, fields[k] || (!anyField && i === 0 && obj.summary ? obj.summary : "")]);
}

export function dossierStats(session) {
  if (!session) return { pct: 0, filled: 0, total: 0, ready: false };
  let filled = 0;
  let total = 0;
  Object.values(session.objects || {}).forEach((obj) => {
    fieldValues(obj).forEach(([, v]) => { total += 1; if (v) filled += 1; });
  });
  return {
    pct: total ? Math.round((filled / total) * 100) : 0,
    filled,
    total,
    ready: Boolean(session.evaluation && session.evaluation.ready_for_closing),
  };
}

function slotCardHtml(slot, obj, evaluation) {
  const pairs = fieldValues(obj);
  const filledHere = pairs.filter(([, v]) => v).length;
  const pending = (obj && obj.pending) || {};
  const lis = pairs.map(([k, v]) =>
    `<li class="${v ? "" : "empty"}"><strong>${esc(fieldDisplayLabel(slot, k))}</strong>: ${esc(v || "—")}${
      pending[k] ? ` <span class="pending-dot" title="Offener Vorschlag — im Chat prüfen">⚠ Vorschlag</span>` : ""}</li>`).join("");
  const st = obj.status || "open";
  const cov = Math.max(
    Number((evaluation.slot_coverage || {})[slot]) || 0,
    pairs.length ? filledHere / pairs.length : 0,
  );
  const spec = Number((evaluation.slot_specificity || {})[slot]);
  const title = st === "partial" && cov >= 1
    ? "Alle Felder gesetzt, aber wenig konkrete Marker (Zahlen/MRR/Kunden…) → noch nicht belastbar"
    : `Status ${schema.statusLabels[st] || st}`;
  return `<article class="slot-card"><h3>${esc(schema.slotLabels[slot] || slot)}
    <span class="badge ${st}" title="${esc(title)}">${esc(slotBadgeLabel(st, cov, spec))}</span></h3>
    <ul>${lis}</ul></article>`;
}

/** Export links point at the saved session on the server (see dossier/routes.py). */
function setExportLinks(sessionId) {
  const links = {
    downloadMd: sessionId && `/api/sessions/${sessionId}/dossier.md`,
    downloadPdf: sessionId && `/api/sessions/${sessionId}/dossier.pdf`,
    downloadJson: sessionId && `/api/sessions/${sessionId}`,
  };
  Object.entries(links).forEach(([id, href]) => {
    const a = document.getElementById(id);
    if (!a) return;
    if (href) a.href = href; else a.removeAttribute("href");
  });
}

function renderFinalizeUi(session, { pct, filled, total, ready }) {
  const btn = document.getElementById("finalizeBtn");
  const hint = document.getElementById("finalizeHint");
  if (!btn || !hint) return;
  const done = Boolean(session && session.finalized);
  btn.disabled = !session;
  btn.textContent = done ? "Erneut abschließen" : "Dossier abschließen";
  if (!session) {
    hint.textContent = "Kein Gespräch aktiv — zuerst wählen.";
  } else if (done && ready) {
    hint.textContent = "Fertig: abgeschlossen und alle Slots belastbar. Erneutes Speichern überschreibt die Summary.";
  } else if (done) {
    hint.textContent = "Geschlossen, aber noch Lücken — „fertig“ gilt erst bei voller Slot-Abdeckung.";
  } else if (ready) {
    hint.textContent = `Bereit zum Abschluss (alle Slots solid · ${pct}% Felder).`;
  } else if (pct < WEAK_DOSSIER_PCT) {
    hint.textContent = `Noch unvollständig (${pct}% · ${filled}/${total} Felder). Abschließen trotzdem möglich — mit Warnung.`;
  } else {
    hint.textContent = `${pct}% · ${filled}/${total} Felder — noch nicht alle Slots solid.`;
  }
}

export function renderSlots(session) {
  const slotsEl = document.getElementById("slots");
  const stats = dossierStats(session);
  const evaluation = (session && session.evaluation) || {};
  slotsEl.innerHTML = session
    ? Object.keys(schema.slotLabels)
      .map((slot) => slotCardHtml(slot, (session.objects || {})[slot] || {}, evaluation))
      .join("")
    : "";
  document.getElementById("progressBar").style.width = `${stats.pct}%`;
  const pctEl = document.getElementById("dossierPct");
  if (pctEl) pctEl.textContent = `${stats.pct}%`;
  setExportLinks(session ? session.id : null);
  renderFinalizeUi(session, stats);
}
