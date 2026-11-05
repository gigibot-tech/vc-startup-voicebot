/**
 * Dossier feature (browser) - PROPOSAL CARDS (git-merge conflict resolver for dossier fields).
 *
 * WHEN A CARD APPEARS
 * -------------------
 * The backend (features/dossier/review.py) turns every machine-written value that would
 * OVERWRITE a filled dossier field into `session.objects[slot].pending[field]`.
 * This module paints those pending entries, auto-resolves high-confidence ones (prefs),
 * and sends the human's decision back.
 *
 * WHAT THE CARD SHOWS  (merge-conflict layout)
 *   <<<<<<< old · Dossier     current value (−) + [Copy]
 *   =======
 *   >>>>>>> new · Incoming    LLM suggestion (+) + [Copy]
 *   ✎ manual                  empty textarea
 *
 * Auto-resolve: if prefs.autoResolveMin < 1.01 and proposal.confidence >= threshold,
 * POST resolve with choice=new + auto=true (incoming). Manual UI for the rest.
 *
 * BUTTON -> HANDLER -> BACKEND   (features/dossier/routes.py resolve_dossier)
 *       POST /api/sessions/{id}/dossier/resolve {decisions:[…]}
 */

import { api } from "../../shared/api.js";
import { diffHtml, diffWords } from "../../shared/diff.js";
import { esc } from "../../shared/format.js";
import { prefs } from "../prefs/prefs.js";
import { activeId, nav } from "../../shared/state.js";
import { fieldDisplayLabel, schema } from "./dossier-schema.js";

const keyOf = (slot, field) => `${slot}.${field}`;
const ROW_SIZE = 4;

/** Flat list of open proposals of a session: [{slot, field, p}]. */
export function listProposals(session) {
  const out = [];
  Object.entries((session && session.objects) || {}).forEach(([slot, obj]) => {
    Object.entries((obj && obj.pending) || {}).forEach(([field, p]) => out.push({ slot, field, p }));
  });
  return out;
}

/** Split into chunks of ROW_SIZE (last row may be shorter). */
function chunkRows(items, size = ROW_SIZE) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

const sourceLabel = (p) => {
  if (p.source.startsWith("pdf")) return `PDF${p.page ? ` · p. ${p.page}` : ""}`;
  return p.source === "tool" ? "Voice agent" : "Chat";
};

const confOf = (p) => {
  const n = Number(p?.confidence);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
};

/**
 * @param {{voice: object, sessions: object}} deps
 */
export function createProposals({ voice, sessions }) {
  const host = document.getElementById("proposalList");
  /** "slot.field" -> {choice: "old"|"new"|"manual"|null, manual: string} */
  const drafts = new Map();
  /** null = nothing painted yet; never use "" (empty list also signatures to ""). */
  let lastSignature = null;
  let autoBusy = false;
  let lastHistorySig = "";

  const draft = (k) => {
    if (!drafts.has(k)) drafts.set(k, { choice: null, manual: "" });
    return drafts.get(k);
  };
  const isValid = (d) => Boolean(d.choice) && (d.choice !== "manual" || d.manual.trim() !== "");

  function autoResolveMin() {
    const n = Number(prefs.autoResolveMin);
    return Number.isFinite(n) ? n : 0.75;
  }

  /** Flat card refs currently in the DOM. */
  function allCards() {
    return [...host.querySelectorAll(".proposal")].map((c) => ({
      key: c.dataset.key, slot: c.dataset.slot, field: c.dataset.field,
    }));
  }

  function historyHtml(session) {
    const hist = [...(session?.conflict_history || [])].slice().reverse();
    if (!hist.length) return "";
    const autoCount = hist.filter((h) => h.auto).length;
    const manualCount = hist.length - autoCount;
    const metaParts = [];
    if (autoCount) metaParts.push(`${autoCount} auto`);
    if (manualCount) metaParts.push(`${manualCount} manual`);
    const rows = hist.map((h) => {
      const pct = Math.round(confOf(h) * 100);
      const badge = h.auto ? "Auto" : "Manual";
      return `<li class="conflict-hist__item">
        <div class="conflict-hist__top">
          <span class="conflict-hist__badge${h.auto ? " is-auto" : ""}">${esc(badge)}</span>
          <strong class="conflict-hist__field">${esc(schema.slotLabels[h.slot] || h.slot)} · ${esc(fieldDisplayLabel(h.slot, h.field))}</strong>
          <span class="conflict-hist__choice">${esc(h.choice)} · ${pct}%</span>
        </div>
        <div class="conflict-hist__diff"><del>${esc(h.old || "—")}</del><span class="conflict-hist__arrow" aria-hidden="true">→</span><ins>${esc(h.new || "—")}</ins></div>
      </li>`;
    }).join("");
    return `<details class="conflict-hist">
      <summary class="conflict-hist__summary">
        <span class="conflict-hist__title">Resolved conflicts</span>
        <span class="conflict-hist__count">${hist.length}</span>
        ${metaParts.length ? `<span class="conflict-hist__meta">${esc(metaParts.join(" · "))}</span>` : ""}
        <span class="conflict-hist__chev" aria-hidden="true">▾</span>
      </summary>
      <ul class="conflict-hist__list">${rows}</ul>
    </details>`;
  }

  function cardHtml({ slot, field, p }) {
    const k = keyOf(slot, field);
    const d = draft(k);
    const diff = diffWords(p.old, p.new);
    const pct = Math.round(confOf(p) * 100);
    const radio = (value) =>
      `<input type="radio" name="pv-${esc(k)}" value="${value}"${d.choice === value ? " checked" : ""} />`;
    const copyBtn = (text, which) =>
      `<button type="button" class="pv__copy" data-act="copy" data-which="${which}" data-copy="${esc(text)}" title="Copy text">Copy</button>`;
    const quote = p.quote
      ? `<blockquote class="proposal__quote">“${esc(p.quote)}”</blockquote>` : "";
    const incoming = sourceLabel(p);
    return `<article class="proposal" data-key="${esc(k)}" data-slot="${esc(slot)}" data-field="${esc(field)}" data-choice="${esc(d.choice || "")}" data-confidence="${confOf(p)}">
      <header class="proposal__head">
        <strong>${esc(schema.slotLabels[slot] || slot)} · ${esc(fieldDisplayLabel(slot, field))}</strong>
        <span class="proposal__src">Conflict · ${esc(incoming)} · ${pct}% confidence</span>
      </header>
      <div class="conflict" role="group" aria-label="Merge conflict">
        <label class="pv pv--old${d.choice === "old" ? " is-chosen" : ""}">
          <span class="conflict-marker conflict-marker--head">&lt;&lt;&lt;&lt;&lt;&lt;&lt; old · Dossier</span>
          <span class="pv__row">${radio("old")}<span class="pv__sign">−</span>
            <span class="pv__text">${diffHtml(diff.old, esc)}</span>${copyBtn(p.old, "old")}</span>
        </label>
        <div class="conflict-marker conflict-marker--mid" aria-hidden="true">=======</div>
        <label class="pv pv--new${d.choice === "new" ? " is-chosen" : ""}">
          <span class="pv__row">${radio("new")}<span class="pv__sign">+</span>
            <span class="pv__text">${diffHtml(diff.new, esc)}</span>${copyBtn(p.new, "new")}</span>
          <span class="conflict-marker conflict-marker--tail">&gt;&gt;&gt;&gt;&gt;&gt;&gt; new · ${esc(incoming)}</span>
        </label>
      </div>
      <label class="pv pv--manual${d.choice === "manual" ? " is-chosen" : ""}">${radio("manual")}<span class="pv__sign">✎</span>
        <textarea rows="2" placeholder="Merge manually: paste or type…" spellcheck="true">${esc(d.manual)}</textarea></label>
      ${quote}
      <footer class="proposal__foot">
        <button type="button" class="pill" data-act="save-one"${isValid(d) ? "" : " disabled"}>✓ Resolve conflict</button>
      </footer>
    </article>`;
  }

  function rowHtml(rowItems, rowIndex) {
    const keys = rowItems.map(({ slot, field }) => keyOf(slot, field)).join(",");
    return `<section class="proposal-row" data-row="${rowIndex}" data-keys="${esc(keys)}">
      <div class="proposal-row__bar">
        <span class="proposal-row__label">Row ${rowIndex + 1} · ${rowItems.length} conflict${rowItems.length === 1 ? "" : "s"}</span>
        <div class="proposal-row__actions">
          <button type="button" class="pill-outline" data-act="row-old" data-row="${rowIndex}">Keep old</button>
          <button type="button" class="pill" data-act="row-new" data-row="${rowIndex}">Take all new</button>
        </div>
      </div>
      <div class="proposal-row__grid">${rowItems.map(cardHtml).join("")}</div>
    </section>`;
  }

  function syncButtons() {
    let valid = 0;
    host.querySelectorAll(".proposal").forEach((card) => {
      const d = draft(card.dataset.key);
      const ok = isValid(d);
      if (ok) valid += 1;
      card.dataset.choice = d.choice || "";
      const saveBtn = card.querySelector('[data-act="save-one"]');
      if (saveBtn) saveBtn.disabled = !ok;
      card.querySelectorAll(".pv").forEach((row) => {
        const input = row.querySelector('input[type="radio"]');
        row.classList.toggle("is-chosen", Boolean(input?.checked));
      });
    });
    const all = host.querySelector('[data-act="save-all"]');
    if (all) {
      all.disabled = valid === 0;
      all.textContent = `✓ Save selection (${valid})`;
    }
  }

  /** Cards currently painted in a row (by data-row index). */
  function cardsInRow(rowIndex) {
    const row = host.querySelector(`.proposal-row[data-row="${rowIndex}"]`);
    if (!row) return [];
    return [...row.querySelectorAll(".proposal")].map((c) => ({
      key: c.dataset.key,
      slot: c.dataset.slot,
      field: c.dataset.field,
    }));
  }

  /** Drop resolved cards from the DOM immediately (signature short-circuit must not leave ghosts). */
  function detachResolved(decisions) {
    decisions.forEach((d) => {
      const k = keyOf(d.slot, d.field);
      drafts.delete(k);
      const card = host.querySelector(`.proposal[data-key="${CSS.escape(k)}"]`);
      card?.remove();
    });
    host.querySelectorAll(".proposal-row").forEach((row) => {
      if (!row.querySelector(".proposal")) row.remove();
    });
    if (!host.querySelector(".proposal")) {
      // Keep history panel if we repaint from session next.
      host.querySelector(".proposal-list__rows")?.remove();
      host.querySelector(".proposal-list__head")?.remove();
    } else {
      syncButtons();
      const h3 = host.querySelector(".proposal-list__head h3");
      const left = host.querySelectorAll(".proposal").length;
      if (h3) h3.textContent = `${left} merge conflict${left === 1 ? "" : "s"}`;
    }
    lastSignature = null;
  }

  function paintShell(session, items) {
    const rows = chunkRows(items);
    const min = autoResolveMin();
    const thrLabel = min >= 1.01 ? "off" : `${Math.round(min * 100)}%`;
    host.hidden = false;
    host.innerHTML = `<div class="proposal-list__head">
        <h3>${items.length} merge conflict${items.length === 1 ? "" : "s"}</h3>
        <p>Like Git: <code>&lt;&lt;&lt;</code> keep old, <code>&gt;&gt;&gt;</code> take incoming.
          Auto-resolve (incoming) when confidence ≥ <strong>${esc(thrLabel)}</strong> — change in Settings.</p>
        <div class="proposal-list__head-actions">
          <button type="button" class="pill-outline" data-act="all-old">Keep all old</button>
          <button type="button" class="pill" data-act="all-new">Take all new</button>
          <button type="button" class="pill-outline" data-act="save-all" disabled>✓ Save selection (0)</button>
        </div>
      </div>
      <div class="proposal-list__rows">${rows.map(rowHtml).join("")}</div>
      ${historyHtml(session)}`;
    syncButtons();
  }

  /**
   * Auto-accept incoming for proposals at/above prefs threshold.
   * @param {object} session
   */
  async function autoResolveHighConfidence(session) {
    const min = autoResolveMin();
    if (autoBusy || min >= 1.01 || !session) return;
    const items = listProposals(session).filter(({ p }) => confOf(p) >= min);
    if (!items.length) return;
    const id = activeId();
    if (!id || id !== session.id) return;
    autoBusy = true;
    const seq = nav.seq;
    const decisions = items.map(({ slot, field }) => ({
      slot, field, choice: "new", manual_text: "", auto: true,
    }));
    try {
      const data = await api(`/api/sessions/${id}/dossier/resolve`, {
        method: "POST",
        body: JSON.stringify({ decisions }),
      });
      if (nav.isStale(seq, id)) return;
      detachResolved(decisions);
      sessions.patchActiveSession(data.session);
      voice.setStatus(`Auto-resolved ${decisions.length} conflict${decisions.length === 1 ? "" : "s"}`);
      void sessions.refreshPicker();
      render(data.session);
    } catch (err) {
      voice.setStatus(String(err.message || err).slice(0, 140));
    } finally {
      autoBusy = false;
    }
  }

  /** Repaint from the session. Cheap no-op unless the set of open proposals / history changed. */
  function render(session) {
    const items = listProposals(session);
    const alive = new Set(items.map(({ slot, field }) => keyOf(slot, field)));
    [...drafts.keys()].forEach((k) => { if (!alive.has(k)) drafts.delete(k); });
    const hist = session?.conflict_history || [];
    const histSig = `${session?.id || ""}|${hist.length}|${hist.at(-1)?.at || ""}`;

    if (!items.length) {
      lastSignature = null;
      if (hist.length) {
        host.hidden = false;
        if (histSig !== lastHistorySig || !host.querySelector(".conflict-hist")) {
          lastHistorySig = histSig;
          host.innerHTML = historyHtml(session);
        }
      } else {
        lastHistorySig = "";
        host.innerHTML = "";
        host.hidden = true;
      }
      return;
    }

    const signature = items.map(({ slot, field, p }) =>
      `${session.id}|${keyOf(slot, field)}|${p.old}|${p.new}|${confOf(p)}`).join("§");
    if (signature === lastSignature && histSig === lastHistorySig) {
      void autoResolveHighConfidence(session);
      return;
    }
    lastSignature = signature;
    lastHistorySig = histSig;
    paintShell(session, items);
    void autoResolveHighConfidence(session);
  }

  /**
   * POST decisions. `forcedChoice` overrides drafts (used by row/head bulk: always old/new).
   * @param {{key:string,slot:string,field:string}[]} cards
   * @param {{forcedChoice?: "old"|"new", auto?: boolean}} [opts]
   */
  async function save(cards, { forcedChoice, auto = false } = {}) {
    const id = activeId();
    const clean = (cards || []).filter((c) => c && c.key && c.slot && c.field);
    const decisions = clean.map(({ key, slot, field }) => {
      if (forcedChoice) {
        draft(key).choice = forcedChoice;
        return { slot, field, choice: forcedChoice, manual_text: "", auto: Boolean(auto) };
      }
      const d = draft(key);
      return {
        slot, field, choice: d.choice,
        manual_text: d.choice === "manual" ? d.manual : "",
        auto: false,
      };
    }).filter((d) => d.choice && (d.choice !== "manual" || d.manual_text.trim()));
    if (!id || !decisions.length) {
      voice.setStatus("No valid selection — pick old / new / manual");
      return;
    }
    const seq = nav.seq;
    try {
      const data = await api(`/api/sessions/${id}/dossier/resolve`, {
        method: "POST",
        body: JSON.stringify({ decisions }),
      });
      if (nav.isStale(seq, id)) return;
      detachResolved(decisions);
      sessions.patchActiveSession(data.session);
      voice.setStatus(`${decisions.length} conflict${decisions.length === 1 ? "" : "s"} resolved`);
      void sessions.refreshPicker();
      render(data.session);
    } catch (err) {
      voice.setStatus(String(err.message || err).slice(0, 140));
    }
  }

  const cardOf = (el) => {
    const card = el?.closest?.(".proposal");
    if (!card) return null;
    return { key: card.dataset.key, slot: card.dataset.slot, field: card.dataset.field };
  };

  function bind() {
    host.addEventListener("change", (e) => {
      const card = cardOf(e.target);
      if (card && e.target.type === "radio") { draft(card.key).choice = e.target.value; syncButtons(); }
    });
    host.addEventListener("input", (e) => {
      const card = cardOf(e.target);
      if (!card || e.target.tagName !== "TEXTAREA") return;
      const d = draft(card.key);
      d.manual = e.target.value;
      if (e.target.value.trim()) {
        d.choice = "manual";
        const manualRadio = e.target.closest(".proposal")?.querySelector('input[value="manual"]');
        if (manualRadio) manualRadio.checked = true;
      }
      syncButtons();
    });
    host.addEventListener("click", async (e) => {
      const btn = e.target.closest("[data-act]");
      const act = btn?.dataset.act;
      if (!act) return;
      if (act === "copy") {
        e.preventDefault();
        e.stopPropagation();
        const text = btn.dataset.copy || "";
        try {
          await navigator.clipboard.writeText(text);
          const prev = btn.textContent;
          btn.textContent = "Copied";
          btn.disabled = true;
          setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200);
        } catch (err) {
          voice.setStatus(`Copy failed: ${String(err.message || err).slice(0, 80)}`);
        }
        return;
      }
      if (act === "save-one") {
        const card = cardOf(btn);
        if (!card) { voice.setStatus("Card not found"); return; }
        if (!isValid(draft(card.key))) {
          voice.setStatus("Pick old, new, or manual first");
          return;
        }
        void save([card]);
        return;
      }
      if (act === "save-all") {
        void save(allCards().filter((c) => isValid(draft(c.key))));
        return;
      }
      if (act === "all-old" || act === "all-new") {
        e.preventDefault();
        const cards = allCards();
        if (!cards.length) {
          voice.setStatus("No open conflicts");
          return;
        }
        void save(cards, { forcedChoice: act === "all-old" ? "old" : "new" });
        return;
      }
      if (act === "row-old" || act === "row-new") {
        e.preventDefault();
        const row = btn.closest(".proposal-row");
        const cards = row
          ? [...row.querySelectorAll(".proposal")].map((c) => ({
              key: c.dataset.key, slot: c.dataset.slot, field: c.dataset.field,
            }))
          : cardsInRow(Number(btn.dataset.row));
        if (!cards.length) {
          voice.setStatus("No cards in this row");
          return;
        }
        void save(cards, { forcedChoice: act === "row-old" ? "old" : "new" });
      }
    });
  }

  return { render, bind, autoResolveHighConfidence };
}
