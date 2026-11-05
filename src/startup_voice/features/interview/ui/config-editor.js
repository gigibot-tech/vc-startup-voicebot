/**
 * Interview feature (browser) - editor for the system prompt, greeting and question catalog.
 *
 * BUTTON -> HANDLER -> BACKEND   (backend docs: features/interview/routes.py)
 * ==========================================================================
 *
 * [Prompt speichern]  #savePromptBtn   (Einstellungen > System-Prompt)  -> save()
 * [Katalog speichern] #saveCatalogBtn  (Dossier > Fragenkatalog)        -> save()
 *     PUT /api/interview-config {greeting, reply_system_prompt, slot_questions, followup_mode}
 *     Both buttons save the SAME document (prompt + catalog + followup together).
 *     If a session is open, followup_mode is also PATCH'd onto that session.
 *
 * [Defaults] #resetPromptBtn / #resetCatalogBtn                         -> reset()
 *     POST /api/interview-config/reset -> server deletes its saved file and returns the defaults.
 *
 * #followupModeSelect change -> PATCH /api/sessions/{id} {followup_mode} when a chat is open
 *     (per-session Nachhaken); always updates the in-memory form for the next global save.
 *
 * No LLM call here. The saved text is used from the NEXT turn on.
 * Slot list for the catalog = the slots of GET /api/dossier-schema (not hard-coded here).
 */

import { api } from "../../shared/api.js";
import { esc } from "../../shared/format.js";
import { activeSession } from "../../shared/state.js";
import { schema } from "../dossier/dossier-schema.js";

const DEFAULT_FOLLOWUP = "balanced";

/**
 * @param {{sessions?: {patchActiveSession: (s: object) => boolean}}} [deps]
 */
export function createConfigEditor(deps = {}) {
  let config = null; // last global config from the server

  const el = (id) => document.getElementById(id);
  const slotIds = () => Object.keys(schema.slotLabels);

  function paint(cfg) {
    config = cfg;
    if (el("greetingInput")) el("greetingInput").value = cfg.greeting || "";
    if (el("systemPromptInput")) el("systemPromptInput").value = cfg.reply_system_prompt || "";
    paintFollowupSelect();
    const host = el("catalogFields");
    if (!host) return;
    host.innerHTML = slotIds().map((slot) => {
      const val = (cfg.slot_questions && cfg.slot_questions[slot]) || "";
      return `<label class="setting"><span>${esc(schema.slotLabels[slot] || slot)}</span>
        <textarea data-slot="${esc(slot)}" rows="2" spellcheck="true">${esc(val)}</textarea></label>`;
    }).join("");
  }

  /** Active session's followup_mode wins over global config. */
  function paintFollowupSelect() {
    const modeEl = el("followupModeSelect");
    if (!modeEl) return;
    const session = activeSession();
    const mode = (session?.followup_mode || config?.followup_mode || DEFAULT_FOLLOWUP);
    modeEl.value = mode;
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
      followup_mode: el("followupModeSelect")?.value || DEFAULT_FOLLOWUP,
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

  /** Persist followup_mode on the open session (no-op if picker / no session). */
  async function syncSessionFollowup(mode) {
    const session = activeSession();
    if (!session?.id) return null;
    const updated = await api(`/api/sessions/${session.id}`, {
      method: "PATCH",
      body: JSON.stringify({ followup_mode: mode || DEFAULT_FOLLOWUP }),
    });
    deps.sessions?.patchActiveSession?.(updated);
    return updated;
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

  const save = (statusId) => run(statusId, "Saved", async () => {
    const body = readForm();
    const cfg = await api("/api/interview-config", {
      method: "PUT",
      body: JSON.stringify(body),
    });
    try {
      await syncSessionFollowup(body.followup_mode);
    } catch (_) { /* global save still ok */ }
    return cfg;
  });
  const reset = (statusId) => run(statusId, "Defaults loaded", async () => {
    const cfg = await api("/api/interview-config/reset", { method: "POST", body: "{}" });
    try {
      await syncSessionFollowup(cfg.followup_mode || DEFAULT_FOLLOWUP);
    } catch (_) { /* ignore */ }
    return cfg;
  });

  function bind() {
    el("savePromptBtn")?.addEventListener("click", () => save("promptSaveStatus"));
    el("resetPromptBtn")?.addEventListener("click", () => reset("promptSaveStatus"));
    el("saveCatalogBtn")?.addEventListener("click", () => save("catalogSaveStatus"));
    el("resetCatalogBtn")?.addEventListener("click", () => reset("catalogSaveStatus"));
    el("followupModeSelect")?.addEventListener("change", async () => {
      const mode = el("followupModeSelect")?.value || DEFAULT_FOLLOWUP;
      try {
        await syncSessionFollowup(mode);
      } catch (err) {
        flash(el("promptSaveStatus"), String(err.message || err).slice(0, 80));
      }
    });
  }

  return { load, bind, paintFollowupSelect };
}
