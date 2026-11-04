/**
 * Interview feature (browser) - editor for the system prompt, greeting and question catalog.
 *
 * BUTTON -> HANDLER -> BACKEND   (backend docs: features/interview/routes.py)
 * ==========================================================================
 *
 * [Prompt speichern]  #savePromptBtn   (Einstellungen > System-Prompt)  -> save()
 * [Katalog speichern] #saveCatalogBtn  (Dossier > Fragenkatalog)        -> save()
 *     PUT /api/interview-config {greeting, reply_system_prompt, slot_questions}
 *     Both buttons save the SAME document (prompt + catalog together).
 *
 * [Defaults] #resetPromptBtn / #resetCatalogBtn                         -> reset()
 *     POST /api/interview-config/reset -> server deletes its saved file and returns the defaults.
 *
 * No LLM call here. The saved text is used from the NEXT turn on.
 * Slot list for the catalog = the slots of GET /api/dossier-schema (not hard-coded here).
 */

import { api } from "../../shared/api.js";
import { esc } from "../../shared/format.js";
import { schema } from "../dossier/dossier-schema.js";

export function createConfigEditor() {
  let config = null; // last config received from the server

  const el = (id) => document.getElementById(id);
  const slotIds = () => Object.keys(schema.slotLabels);

  function paint(cfg) {
    config = cfg;
    if (el("greetingInput")) el("greetingInput").value = cfg.greeting || "";
    if (el("systemPromptInput")) el("systemPromptInput").value = cfg.reply_system_prompt || "";
    const host = el("catalogFields");
    if (!host) return;
    host.innerHTML = slotIds().map((slot) => {
      const val = (cfg.slot_questions && cfg.slot_questions[slot]) || "";
      return `<label class="setting"><span>${esc(schema.slotLabels[slot] || slot)}</span>
        <textarea data-slot="${esc(slot)}" rows="2" spellcheck="true">${esc(val)}</textarea></label>`;
    }).join("");
  }

  /** Read the form. Slots whose textarea is not painted yet keep the last server value. */
  function readForm() {
    const questions = { ...((config && config.slot_questions) || {}) };
    document.querySelectorAll("#catalogFields textarea[data-slot]").forEach((t) => {
      questions[t.dataset.slot] = t.value.trim();
    });
    return {
      greeting: el("greetingInput")?.value || "",
      reply_system_prompt: el("systemPromptInput")?.value || "",
      slot_questions: questions,
    };
  }

  function flash(statusEl, text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    setTimeout(() => { statusEl.textContent = ""; }, 1800);
  }

  async function load() {
    try { paint(await api("/api/interview-config")); }
    catch (_) { /* defaults stay empty until save */ }
  }

  /** Run `action`, show `okText` in the status span, or the error message. */
  async function run(statusId, okText, action) {
    const statusEl = el(statusId);
    try {
      paint(await action());
      flash(statusEl, okText);
    } catch (err) {
      if (statusEl) statusEl.textContent = String(err.message || err).slice(0, 80);
    }
  }

  const save = (statusId) => run(statusId, "Gespeichert", () =>
    api("/api/interview-config", { method: "PUT", body: JSON.stringify(readForm()) }));
  const reset = (statusId) => run(statusId, "Defaults geladen", () =>
    api("/api/interview-config/reset", { method: "POST", body: "{}" }));

  function bind() {
    el("savePromptBtn")?.addEventListener("click", () => save("promptSaveStatus"));
    el("resetPromptBtn")?.addEventListener("click", () => reset("promptSaveStatus"));
    el("saveCatalogBtn")?.addEventListener("click", () => save("catalogSaveStatus"));
    el("resetCatalogBtn")?.addEventListener("click", () => reset("catalogSaveStatus"));
  }

  return { load, bind };
}
