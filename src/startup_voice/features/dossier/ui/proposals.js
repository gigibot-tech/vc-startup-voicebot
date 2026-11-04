/**
 * Dossier feature (browser) - PROPOSAL CARDS ("git diff" for dossier fields), shown in the chat.
 *
 * WHEN A CARD APPEARS
 * -------------------
 * The backend (features/dossier/review.py) turns every machine-written value that would
 * OVERWRITE a filled dossier field into `session.objects[slot].pending[field] = {old, new, source,
 * quote, page}`. Sources: the chat extraction, the PersonaPlex tool webhook, an uploaded PDF.
 * This module only PAINTS those pending entries and sends the human's decision back.
 *
 * WHAT THE CARD SHOWS
 *   −  old value (Dossier)   deleted words in red
 *   +  new value (LLM)       inserted words in green        + quote / page when the source has one
 *   ✎  manual                empty textarea: paste or type your own wording
 * Pick exactly ONE of the three (radio), then [Speichern]. "manual" needs non-empty text; the
 * button stays disabled until that is true (the server checks again and answers 400 otherwise).
 *
 * BUTTON -> HANDLER -> BACKEND   (backend docs: features/dossier/routes.py resolve_dossier)
 * ==========================================================================
 *   [✓ Speichern] (one card)         -> save([that decision])
 *   [✓ Alle gewählten speichern]     -> save(all cards that have a valid choice)
 *       POST /api/sessions/{id}/dossier/resolve {decisions:[{slot,field,choice,manual_text}]}
 *       -> server applies all-or-nothing, rescoring, saves. No LLM call.
 *
 * DRAFTS: the user's half-made choice and typed text live in `drafts`, keyed by "slot.field", so
 * repainting the page (state changes while a reply streams) never wipes what they typed. The
 * cards are only rebuilt when the SET of open proposals changes.
 */

import { api } from "../../shared/api.js";
import { diffHtml, diffWords } from "../../shared/diff.js";
import { esc } from "../../shared/format.js";
import { activeId, nav } from "../../shared/state.js";
import { fieldDisplayLabel, schema } from "./dossier-schema.js";

const keyOf = (slot, field) => `${slot}.${field}`;

/** Flat list of open proposals of a session: [{slot, field, p}]. */
export function listProposals(session) {
  const out = [];
  Object.entries((session && session.objects) || {}).forEach(([slot, obj]) => {
    Object.entries((obj && obj.pending) || {}).forEach(([field, p]) => out.push({ slot, field, p }));
  });
  return out;
}

const sourceLabel = (p) => {
  if (p.source.startsWith("pdf")) return `PDF${p.page ? ` · S. ${p.page}` : ""}`;
  return p.source === "tool" ? "Sprach-Agent" : "Chat";
};

/**
 * @param {{voice: object, sessions: object}} deps
 *   voice    - setStatus for feedback
 *   sessions - patchActiveSession / refreshPicker after a save
 */
export function createProposals({ voice, sessions }) {
  const host = document.getElementById("proposalList");
  /** "slot.field" -> {choice: "old"|"new"|"manual"|null, manual: string} */
  const drafts = new Map();
  let lastSignature = "";

  const draft = (k) => {
    if (!drafts.has(k)) drafts.set(k, { choice: null, manual: "" });
    return drafts.get(k);
  };
  const isValid = (d) => Boolean(d.choice) && (d.choice !== "manual" || d.manual.trim() !== "");

  function cardHtml({ slot, field, p }) {
    const k = keyOf(slot, field);
    const d = draft(k);
    const diff = diffWords(p.old, p.new);
    const radio = (value) =>
      `<input type="radio" name="pv-${esc(k)}" value="${value}"${d.choice === value ? " checked" : ""} />`;
    const quote = p.quote
      ? `<blockquote class="proposal__quote">„${esc(p.quote)}“</blockquote>` : "";
    return `<article class="proposal" data-key="${esc(k)}" data-slot="${esc(slot)}" data-field="${esc(field)}">
      <header class="proposal__head">
        <strong>${esc(schema.slotLabels[slot] || slot)} · ${esc(fieldDisplayLabel(slot, field))}</strong>
        <span class="proposal__src">${esc(sourceLabel(p))}</span>
      </header>
      <label class="pv pv--old">${radio("old")}<span class="pv__sign">−</span>
        <span class="pv__text">${diffHtml(diff.old, esc)}</span></label>
      <label class="pv pv--new">${radio("new")}<span class="pv__sign">+</span>
        <span class="pv__text">${diffHtml(diff.new, esc)}</span></label>
      <label class="pv pv--manual">${radio("manual")}<span class="pv__sign">✎</span>
        <textarea rows="2" placeholder="Manuell: eigenen Text hier einfügen oder schreiben…" spellcheck="true">${esc(d.manual)}</textarea></label>
      ${quote}
      <footer class="proposal__foot">
        <button type="button" class="pill" data-act="save-one"${isValid(d) ? "" : " disabled"}>✓ Speichern</button>
      </footer>
    </article>`;
  }

  function syncButtons() {
    let valid = 0;
    host.querySelectorAll(".proposal").forEach((card) => {
      const ok = isValid(draft(card.dataset.key));
      if (ok) valid += 1;
      card.querySelector('[data-act="save-one"]').disabled = !ok;
    });
    const all = host.querySelector('[data-act="save-all"]');
    if (all) {
      all.disabled = valid === 0;
      all.textContent = `✓ Alle gewählten speichern (${valid})`;
    }
  }

  /** Repaint from the session. Cheap no-op unless the set of open proposals changed. */
  function render(session) {
    const items = listProposals(session);
    const signature = items.map(({ slot, field, p }) => `${session.id}|${keyOf(slot, field)}|${p.old}|${p.new}`).join("§");
    if (signature === lastSignature) return;
    lastSignature = signature;
    const alive = new Set(items.map(({ slot, field }) => keyOf(slot, field)));
    [...drafts.keys()].forEach((k) => { if (!alive.has(k)) drafts.delete(k); });
    if (!items.length) { host.innerHTML = ""; host.hidden = true; return; }
    host.hidden = false;
    host.innerHTML = `<div class="proposal-list__head">
        <h3>${items.length} Vorschlag${items.length === 1 ? "" : "e"} zur Prüfung</h3>
        <p>Das Dossier behält den alten Wert, bis du wählst.</p>
        <button type="button" class="pill-outline" data-act="save-all" disabled>✓ Alle gewählten speichern (0)</button>
      </div>${items.map(cardHtml).join("")}`;
    syncButtons();
  }

  /** POST the given decisions; the server answers with the fresh session. */
  async function save(cards) {
    const id = activeId();
    const decisions = cards.map(({ key, slot, field }) => {
      const d = draft(key);
      return { slot, field, choice: d.choice, manual_text: d.choice === "manual" ? d.manual : "" };
    });
    if (!id || !decisions.length) return;
    const seq = nav.seq;
    try {
      const data = await api(`/api/sessions/${id}/dossier/resolve`, {
        method: "POST",
        body: JSON.stringify({ decisions }),
      });
      if (nav.isStale(seq, id)) return;
      lastSignature = ""; // force repaint even if the set looks the same
      sessions.patchActiveSession(data.session);
      voice.setStatus(`${decisions.length} Feld${decisions.length === 1 ? "" : "er"} gespeichert`);
      sessions.refreshPicker();
    } catch (err) {
      voice.setStatus(String(err.message || err).slice(0, 140));
    }
  }

  const cardOf = (el) => {
    const card = el.closest(".proposal");
    return card && { key: card.dataset.key, slot: card.dataset.slot, field: card.dataset.field };
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
      if (e.target.value.trim()) { // typing in the manual box selects "manual" automatically
        d.choice = "manual";
        e.target.closest(".proposal").querySelector('input[value="manual"]').checked = true;
      }
      syncButtons();
    });
    host.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "save-one") save([cardOf(e.target)]);
      if (act === "save-all") {
        save([...host.querySelectorAll(".proposal")]
          .map((c) => ({ key: c.dataset.key, slot: c.dataset.slot, field: c.dataset.field }))
          .filter((c) => isValid(draft(c.key))));
      }
    });
  }

  return { render, bind };
}
