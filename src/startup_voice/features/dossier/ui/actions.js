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
import { activeId, activeSession, appState, nav, notify, setLoading } from "../../shared/state.js";
import { listProposals } from "./proposals.js";
import { dossierStats, WEAK_DOSSIER_PCT } from "./render.js";

/**
 * @param {{voice: object, sessions: object, repaintList: () => void}} deps
 *   voice       - setStatus / setVoicePhase for the status line
 *   sessions    - createSessions() result (goPicker, refreshPicker, ...)
 *   repaintList - repaint sidebar/dropdown without touching the chat
 */
export function createDossierActions({ voice, sessions, repaintList }) {
  async function finalize() {
    const id = activeId();
    const session = activeSession();
    if (!id || !session) {
      voice.setStatus(appState.loading ? "Noch am Laden…" : "Kein Gespräch geladen");
      return;
    }
    if (appState.loading) {
      voice.setStatus("Bitte warten — Vorgang läuft");
      return;
    }
    const { pct, filled, total, ready } = dossierStats(session);
    const open = listProposals(session).length;
    if (open && !confirm(`${open} Vorschlag/Vorschläge ungeklärt — es gilt jeweils der alte Wert. Trotzdem abschließen?`)) return;
    if (session.finalized) {
      if (!confirm("Dossier wurde schon abgeschlossen. Erneut speichern und Summary überschreiben?")) return;
    } else if (!ready && pct < WEAK_DOSSIER_PCT) {
      if (!confirm(`Dossier ist erst zu ${pct}% gefüllt (${filled}/${total} Felder). Trotzdem abschließen?`)) return;
    } else if (!ready) {
      if (!confirm(`Noch Lücken im Dossier (${pct}%). Trotzdem abschließen?`)) return;
    }
    const seq = nav.seq;
    setLoading(true, "finalize");
    voice.setStatus("Dossier wird abgeschlossen…");
    let data;
    try {
      data = await api(`/api/sessions/${id}/finalize`, { method: "POST", body: "{}" });
    } catch (err) {
      setLoading(false);
      voice.setVoicePhase("idle", `Abschluss fehlgeschlagen — ${String(err.message || err).slice(0, 120)}`);
      return;
    }
    if (!data.session || data.session.id !== id) {
      setLoading(false);
      voice.setStatus("Finalize-Antwort passt nicht zur aktiven Session");
      return;
    }
    // Sidebar shows "geschlossen/fertig" immediately, before the list reload returns.
    sessions.applySessionToList(data.session);
    appState.loading = false;
    appState.loadingKind = null;
    notify();
    try { await sessions.refreshPicker(); }
    catch { /* keep optimistic list entry */ }
    if (appState.sessionId === id || seq === nav.seq) {
      sessions.goPicker({ status: "Dossier abgeschlossen — Gespräch wählen" });
    } else {
      repaintList();
      voice.setStatus("Dossier abgeschlossen (Liste aktualisiert)");
    }
  }

  async function clearDossier() {
    const id = activeId();
    if (!id || !activeSession() || !confirm("Nur Dossier-Felder leeren? Chat bleibt erhalten.")) return;
    const seq = nav.seq;
    const data = await api(`/api/sessions/${id}/clear`, { method: "POST", body: "{}" });
    if (nav.isStale(seq, id)) return;
    if (data.session?.id === id) sessions.patchActiveSession(data.session);
    voice.setStatus("Dossier geleert");
    sessions.refreshPicker();
  }

  async function deleteSession() {
    const id = activeId();
    if (!id || !activeSession() || !confirm("Gespräch inkl. Dossier endgültig löschen?")) return;
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    await sessions.refreshPicker();
    sessions.goPicker({ status: "Gespräch gelöscht — bitte wählen" });
  }

  function bind() {
    document.getElementById("finalizeBtn").addEventListener("click", () => finalize());
    document.getElementById("clearBtn").addEventListener("click", clearDossier);
    document.getElementById("deleteBtn").addEventListener("click", deleteSession);
  }

  return { finalize, bind };
}
