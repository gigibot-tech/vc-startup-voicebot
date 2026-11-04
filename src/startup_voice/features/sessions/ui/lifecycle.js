/**
 * Sessions feature (browser): create / open / leave a conversation, keep ?s=<id> in the URL.
 *
 * BUTTON -> HANDLER -> BACKEND   (backend docs: features/sessions/routes.py)
 * ==========================================================================
 *
 * [Neues Gespräch]            #newBtn         -> bind(): refreshPicker() + goPicker()
 *                                                GET /api/sessions   (nothing is created yet)
 * [Neues Gespräch jetzt starten] #confirmNewBtn -> startSession()
 *                                                POST /api/sessions {language}  (no LLM call; the
 *                                                server returns an empty session + greeting)
 * [Gespräch wählen] sidebar entries, home list, ?s=<id>, browser back button
 *                                             -> openSession(id)
 *                                                GET /api/sessions/{id}
 *
 * Every function here changes `appState` and calls notify(); app.js repaints from that.
 */

import { api } from "../../shared/api.js";
import { appState, nav, notify } from "../../shared/state.js";
import { upsertSession } from "./session-list.js";

export function readUrlSessionId() {
  try { return new URL(window.location.href).searchParams.get("s"); }
  catch { return null; }
}

/** Mirror the open conversation into the address bar so reload / back button work. */
export function syncUrl() {
  const url = new URL(window.location.href);
  if (appState.view === "session" && appState.sessionId) {
    url.searchParams.set("s", appState.sessionId);
  } else {
    url.searchParams.delete("s");
  }
  history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * @param {{voice: object, prefLanguage: () => string}} deps
 *   voice        - createVoice() result (we stop audio / mic when switching conversation)
 *   prefLanguage - language picked in the settings bar; used for NEW conversations only
 */
export function createSessions({ voice, prefLanguage }) {
  const sessionList = document.getElementById("sessionList");
  const homeSessionList = document.getElementById("homeSessionList");

  /** Show the conversation picker (no conversation open). */
  function goPicker({ status } = {}) {
    nav.bump();
    voice.stopSpeak();
    voice.stopMicCapture({ keepPhase: true });
    nav.turnBusy = false;
    appState.view = "picker";
    appState.sessionId = null;
    appState.session = null;
    appState.loading = false;
    appState.loadingKind = null;
    voice.setVoicePhase("idle", status || "Gespräch wählen");
    notify();
  }

  /** Open a session object we already have (e.g. just created). Optionally read its last reply. */
  function commitSession(s, { status, speakLast } = {}) {
    if (!s || !s.id) return;
    nav.bump();
    appState.view = "session";
    appState.sessionId = s.id;
    appState.session = s;
    appState.loading = false;
    appState.loadingKind = null;
    voice.setVoicePhase("idle", status || "Bereit");
    notify();
    if (speakLast) {
      const last = [...(s.messages || [])].reverse().find((m) => m.role === "assistant");
      if (last) voice.speak(last.content);
    }
  }

  /** Replace the open session with a fresher copy from the server. False if it is not the open one. */
  function patchActiveSession(s) {
    if (!s || s.id !== appState.sessionId) return false;
    appState.session = s;
    notify();
    return true;
  }

  function applySessionToList(s) {
    appState.list = upsertSession(appState.list, s);
  }

  /** GET /api/sessions -> newest first. */
  async function refreshPicker() {
    const data = await api("/api/sessions");
    appState.list = [...(data.sessions || [])].sort((a, b) =>
      String(b.created_at || "").localeCompare(String(a.created_at || "")));
    notify();
    return appState.list;
  }

  /** POST /api/sessions -> empty conversation with the greeting as first assistant message. */
  async function startSession() {
    const data = await api("/api/sessions", {
      method: "POST",
      body: JSON.stringify({ language: prefLanguage() }),
    });
    commitSession(data.session, { status: "Neues Gespräch — bitte antworten" });
    await refreshPicker();
  }

  /** GET /api/sessions/{id}. A newer navigation (nav.seq) cancels this one's result. */
  async function openSession(id) {
    if (!id) return;
    if (appState.loading && appState.loadingKind === "finalize") return;
    const seq = nav.bump();
    voice.stopSpeak();
    voice.stopMicCapture({ keepPhase: true });
    nav.turnBusy = false;
    // Bind id immediately for sidebar highlight; keep previous session painted until fetch returns.
    appState.view = "session";
    appState.sessionId = id;
    if (appState.session && appState.session.id !== id) {
      appState.session = null; // switching chats: clear only when it really is a different one
    }
    appState.loading = true;
    appState.loadingKind = "open";
    notify();
    voice.setStatus("Lädt…");
    try {
      const s = await api(`/api/sessions/${id}`);
      if (nav.isStale(seq, id)) return; // superseded
      if (!s || s.id !== id) {
        goPicker({ status: "Session-Antwort ungültig" });
        return;
      }
      appState.session = s;
      appState.loading = false;
      appState.loadingKind = null;
      applySessionToList(s);
      voice.setVoicePhase("idle", "Gespräch geladen");
      notify();
    } catch (err) {
      if (seq !== nav.seq) return;
      appState.loading = false;
      appState.loadingKind = null;
      goPicker({ status: String(err.message || err).slice(0, 120) });
    }
  }

  /** Wire the buttons / lists listed in the header comment. */
  function bind() {
    // [Neues Gespräch] - just show the picker; creating happens in #confirmNewBtn.
    document.getElementById("newBtn").addEventListener("click", async () => {
      await refreshPicker();
      goPicker();
    });
    // [Neues Gespräch jetzt starten] - POST /api/sessions
    document.getElementById("confirmNewBtn").addEventListener("click", () => startSession());
    // Sidebar + picker-screen list entries - GET /api/sessions/{id}
    const onSessionClick = (e) => {
      const btn = e.target.closest(".session-item");
      if (btn?.dataset.id) openSession(btn.dataset.id);
    };
    sessionList.addEventListener("click", onSessionClick);
    homeSessionList.addEventListener("click", onSessionClick);
    // Browser back/forward changes ?s=<id>
    window.addEventListener("popstate", () => {
      const id = readUrlSessionId();
      if (id) openSession(id);
      else goPicker();
    });
  }

  return {
    goPicker, commitSession, patchActiveSession, applySessionToList,
    refreshPicker, startSession, openSession, bind,
  };
}
