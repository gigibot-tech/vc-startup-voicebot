/**
 * Dossier feature (browser) - the buttons in the dossier panel.
 *
 * BUTTON -> HANDLER -> BACKEND   (backend docs: dossier/routes.py, interview/routes.py,
 *                                 sessions/routes.py)
 * ===================================================================================
 *
 * [Dossier abschließen] #finalizeBtn  -> finalize()
 *     confirm() if proposals are still open / the dossier is weak / already closed, then
 *     POST /api/sessions/{id}/finalize   (calls the LLM once, for the spoken summary)
 *     On success the app returns to the conversation picker.
 *
 * [Dossier leeren]      #clearBtn     -> clear handler
 *     confirm(), then POST /api/sessions/{id}/clear   (no LLM; chat stays, slots emptied)
 *
 * [Gespräch löschen]    #deleteBtn    -> delete handler
 *     confirm(), then DELETE /api/sessions/{id}       (removes the session folder on disk)
 *
 * [Markdown] [PDF] [JSON] are plain <a href download> links; render.js sets their href.
 *     No JS handler. GET /api/sessions/{id}/dossier.md | dossier.pdf | (session JSON)
 *
 * All three async handlers use the stale-response guard from shared/state.js (`nav`): if the
 * user switches conversation while the request is running, its answer is ignored.
 */

import { api } from "../../shared/api.js";
import {
  activeId, activeSession, appState, clearProcessBusy, nav, notify, setLoading, setProcessBusy,
} from "../../shared/state.js";
import { t } from "../prefs/chrome-i18n.js";
import { listProposals } from "./proposals.js";
import { dossierStats, WEAK_DOSSIER_PCT } from "./render.js";

export function hasUnsavedDossier(session) {
  if (!session) return false;
  const versions = Array.isArray(session.dossier_versions) ? session.dossier_versions : [];
  if (!versions.length) return true;
  const latest = versions[versions.length - 1];
  return Number(session.turn_index || 0) > Number(latest.turn_index || 0);
}

/**
 * @param {{voice: object, sessions: object, repaintList: () => void}} deps
 *   voice       - setStatus / setVoicePhase for the status line
 *   sessions    - createSessions() result (goPicker, refreshPicker, ...)
 *   repaintList - repaint sidebar/dropdown without touching the chat
 */
export function createDossierActions({ voice, sessions, repaintList }) {
  async function finalize({ closeAfter = false, autoFromEnd = false } = {}) {
    const id = activeId();
    const session = activeSession();
    if (!id || !session) {
      voice.setStatus(appState.loading ? "Still loading…" : "No session loaded");
      return false;
    }
    if ((appState.processBusy || appState.loading) && !sessions.guardInterrupt()) return false;
    const { pct, filled, total, ready } = dossierStats(session);
    const open = listProposals(session).length;
    if (open && !confirm(`${open} open proposal(s) unresolved — old values stay. Finalize anyway?`)) {
      return false;
    }
    const vCount = Array.isArray(session.dossier_versions) ? session.dossier_versions.length : 0;
    if (!autoFromEnd) {
      if (session.finalized || vCount) {
        if (!confirm(`Save a new timestamped dossier version (v${vCount + 1})? Previous versions stay on disk.`)) {
          return false;
        }
      } else if (!ready && pct < WEAK_DOSSIER_PCT) {
        if (!confirm(`Dossier is only ${pct}% filled (${filled}/${total} fields). Save snapshot anyway?`)) {
          return false;
        }
      } else if (!ready) {
        if (!confirm(`Dossier still has gaps (${pct}%). Save snapshot anyway?`)) {
          return false;
        }
      }
    }
    const seq = nav.seq;
    setLoading(true, "finalize");
    setProcessBusy({
      kind: "finalize",
      sessionId: id,
      message: t("finalizingDossier", session.language || "de"),
    });
    voice.setStatus("Finalizing dossier…");
    let data;
    try {
      data = await api(`/api/sessions/${id}/finalize`, { method: "POST", body: "{}" });
    } catch (err) {
      setLoading(false);
      clearProcessBusy();
      voice.setVoicePhase("idle", `Finalize failed — ${String(err.message || err).slice(0, 120)}`);
      return false;
    }
    if (!data.session || data.session.id !== id) {
      setLoading(false);
      clearProcessBusy();
      voice.setStatus("Finalize response does not match the active session");
      return false;
    }
    sessions.applySessionToList(data.session);
    sessions.patchActiveSession(data.session);
    appState.loading = false;
    appState.loadingKind = null;
    clearProcessBusy();
    delete document.getElementById("app")?.dataset.dismissEnd;
    notify();
    const latestV = (data.session.dossier_versions || []).at(-1);
    const vTag = latestV ? `v${latestV.version}` : "saved";
    const spoken = data.reply || data.summary || data.session?.spoken_summary || "";
    try { await sessions.refreshPicker(); }
    catch { /* keep optimistic list entry */ }
    repaintList();
    if (closeAfter && (appState.sessionId === id || seq === nav.seq)) {
      sessions.goPicker({
        status: `Dossier ${vTag} saved — chat ended`,
        force: true,
      });
      return true;
    }
    voice.setVoicePhase("idle", `Dossier ${vTag} saved locally`);
    if (spoken) void voice.speak(spoken);
    return true;
  }

  /**
   * [Speichern & Beenden] / [Beenden] on the end banner:
   * - If not saved yet (or new turns since last vX): auto-save a new version first, then close.
   * - If current state is already saved in vX: close immediately to picker.
   */
  async function endAndClose() {
    const session = activeSession();
    if (!session) return;
    if (hasUnsavedDossier(session)) {
      await finalize({ closeAfter: true, autoFromEnd: true });
      return;
    }
    const latestV = (session.dossier_versions || []).at(-1);
    const vTag = latestV ? `v${latestV.version}` : "";
    sessions.goPicker({
      status: vTag ? `Dossier ${vTag} saved — chat ended` : "Chat ended",
    });
  }

  async function clearDossier() {
    const id = activeId();
    if (!id || !activeSession()) return;
    if (appState.processBusy && !sessions.guardInterrupt()) return;
    if (!confirm("Clear dossier fields only? Chat stays.")) return;
    const seq = nav.seq;
    const data = await api(`/api/sessions/${id}/clear`, { method: "POST", body: "{}" });
    if (nav.isStale(seq, id)) return;
    if (data.session?.id === id) sessions.patchActiveSession(data.session);
    voice.setStatus("Dossier cleared");
    sessions.refreshPicker();
  }

  async function deleteSession() {
    const id = activeId();
    if (!id || !activeSession()) return;
    if (appState.processBusy && !sessions.guardInterrupt()) return;
    if (!confirm("Permanently delete this session and dossier?")) return;
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    await sessions.refreshPicker();
    sessions.goPicker({ status: "Session deleted — please choose", force: true });
  }

  function bind() {
    document.getElementById("finalizeBtn").addEventListener("click", () => finalize());
    document.getElementById("clearBtn").addEventListener("click", clearDossier);
    document.getElementById("deleteBtn").addEventListener("click", deleteSession);
  }

  return { finalize, endAndClose, bind };
}
