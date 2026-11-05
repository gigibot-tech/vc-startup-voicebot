/**
 * Dossier feature (browser) - painting only. No network calls, no buttons wired here.
 *
 *   renderSlots(session)  slot cards + progress bar + export links + finalize button state
 *   dossierStats(session) {pct, filled, total, ready}  used by the cards AND by the finalize dialog
 *
 * "Ready" is decided by the SERVER (`session.evaluation.ready_for_closing`, see
 * features/dossier/scoring.py). The browser only counts filled fields for the % display.
 */

import { esc, fmtTs } from "../../shared/format.js";
import { fieldDisplayLabel, schema, slotBadgeLabel, slotBadgeTitle } from "./dossier-schema.js";

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
      pending[k] ? ` <span class="pending-dot" title="Open proposal — review in chat">⚠ Proposal</span>` : ""}</li>`).join("");
  const st = obj.status || "open";
  const cov = Math.max(
    Number((evaluation.slot_coverage || {})[slot]) || 0,
    pairs.length ? filledHere / pairs.length : 0,
  );
  const spec = Number((evaluation.slot_specificity || {})[slot]);
  return `<article class="slot-card"><h3>${esc(schema.slotLabels[slot] || slot)}
    <span class="badge ${st}" title="${esc(slotBadgeTitle(st, cov, spec))}">${esc(slotBadgeLabel(st, cov, spec))}</span></h3>
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

function renderVersionsUi(session) {
  const el = document.getElementById("dossierVersions");
  if (!el) return;
  const list = Array.isArray(session?.dossier_versions) ? session.dossier_versions : [];
  if (!session || !list.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const sid = esc(session.id);
  const rows = [...list].reverse().map((v) => {
    const vid = esc(v.id);
    const pct = Math.round(Number(v.field_coverage || 0) * 100);
    const when = fmtTs(v.created_at);
    return `<li class="dossier-version">
      <span class="dossier-version__meta"><strong>v${esc(String(v.version))}</strong> · ${esc(when)} · Turn ${esc(String(v.turn_index ?? 0))} · ${pct}%</span>
      <span class="dossier-version__links">
        <a href="/api/sessions/${sid}/dossiers/${vid}.md" download>MD</a>
        <a href="/api/sessions/${sid}/dossiers/${vid}.pdf" download>PDF</a>
        <a href="/api/sessions/${sid}/dossiers/${vid}.json" download>JSON</a>
      </span>
    </li>`;
  }).join("");
  el.innerHTML = `<div class="dossier-versions__title">Saved dossier versions (${list.length})</div><ul class="dossier-versions__list">${rows}</ul>`;
  el.hidden = false;
}

function renderFinalizeUi(session, { pct, filled, total, ready }) {
  const btn = document.getElementById("finalizeBtn");
  const hint = document.getElementById("finalizeHint");
  const block = document.getElementById("finalizeBlock");
  if (!btn || !hint) return;
  const done = Boolean(session && session.finalized);
  const vCount = Array.isArray(session?.dossier_versions) ? session.dossier_versions.length : 0;
  const offerEnd = Boolean(session && appOfferEnd());
  btn.disabled = !session;
  btn.textContent = vCount
    ? `Save new dossier version (v${vCount + 1})`
    : (done ? "Finalize again" : "Finalize dossier");
  block?.classList.toggle("is-ready", Boolean(session && (ready || offerEnd) && !done));
  if (!session) {
    hint.textContent = "No active session — choose one first.";
  } else if (done && ready) {
    hint.textContent = `Saved locally (${vCount || 1} version${vCount === 1 ? "" : "s"}). Finalizing again saves v${vCount + 1} with timestamp.`;
  } else if (done) {
    hint.textContent = `Saved locally (v${vCount || 1}, still gaps). You can keep chatting and save a new version anytime.`;
  } else if (ready || offerEnd) {
    hint.textContent = ready
      ? `Ready to finalize (all slots solid · ${pct}% fields) — saves a timestamped snapshot locally.`
      : `Agent offered end — review the dossier (${pct}% · ${filled}/${total} fields), then continue or finalize.`;
  } else if (pct < WEAK_DOSSIER_PCT) {
    hint.textContent = `Still incomplete (${pct}% · ${filled}/${total} fields). Finalize still possible — with a warning.`;
  } else {
    hint.textContent = `${pct}% · ${filled}/${total} fields — not all slots solid yet.`;
  }
  renderVersionsUi(session);
}

/** Soft highlight from chat end-banner (session-scoped flag on #app). */
function appOfferEnd() {
  return document.getElementById("app")?.dataset.offerEnd === "1";
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
