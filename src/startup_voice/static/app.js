/**
 * Shell: creates the feature slices, wires them together, paints on state change, boots.
 * No business logic lives here. Where to look:
 *
 *   features/sessions/ui/lifecycle.js        new / open / leave a conversation, ?s= in the URL
 *   features/interview/ui/chat.js            sendText(): the ONLY path from the UI to the LLM
 *   features/interview/ui/config-editor.js   system prompt + question catalog editor
 *   features/dossier/ui/render.js            slot cards, progress, export links
 *   features/dossier/ui/actions.js           finalize / clear / delete buttons
 *   features/dossier/ui/proposals.js         git-diff cards: accept old / new / manual
 *   features/voice/ui/voice.js               mic (STT) + speaker (TTS); never calls the LLM
 *   features/prefs/ui/settings.js            settings bar (localStorage only)
 *   shared/state.js                          appState + stale-response guard
 */
import { api } from "./shared/api.js";
import { appState, activeId, activeSession, isPicker, nav, subscribe } from "./shared/state.js";
import { createVoice } from "./features/voice/voice.js";
import { prefs } from "./features/prefs/prefs.js";
import { createSettings } from "./features/prefs/settings.js";
import { createSessions, readUrlSessionId, syncUrl } from "./features/sessions/lifecycle.js";
import { renderMeta } from "./features/sessions/meta.js";
import { createSessionListView } from "./features/sessions/session-list.js";
import { loadDossierSchema } from "./features/dossier/dossier-schema.js";
import { renderSlots } from "./features/dossier/render.js";
import { createDossierActions } from "./features/dossier/actions.js";
import { createProposals } from "./features/dossier/proposals.js";
import { createChat } from "./features/interview/chat.js";
import { createConfigEditor } from "./features/interview/config-editor.js";

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const qaList = $("qaList");
const textInput = $("textInput");

/** Language of the open conversation; the settings picker only applies to the next new one. */
const prefLanguage = () => String(prefs.lang).slice(0, 2);
const currentLanguage = () => activeSession()?.language || prefLanguage();

/*
 * WIRING: voice.js <-> chat.js.   (voice.js itself NEVER calls the LLM.)
 *
 * createVoice() gives us the ears (STT) and the mouth (TTS). It knows nothing about sessions
 * or the dossier, so WE inject what it needs. The key line is `onTranscript`: voice.js calls it
 * with the final spoken text and we forward it to chat.sendText(), the single entry point that
 * talks to the backend / LLM (POST /api/sessions/{id}/turn/stream).
 */
const voice = createVoice({
  prefs,
  textInput,
  getLanguage: currentLanguage,
  canListen: () => !isPicker() && Boolean(activeSession()),
  onTranscript: (text) => chat.sendText(text), // <-- voice -> LLM hand-off lives HERE
  onProviderChange: () => showMeta(),
  onAbort: () => { nav.turnBusy = false; },
});

const sessions = createSessions({ voice, prefLanguage });
const chat = createChat({ voice, sessions });
const configEditor = createConfigEditor();
const settings = createSettings({ voice, onMetaChange: () => showMeta() });
const proposals = createProposals({ voice, sessions });
const dossierActions = createDossierActions({ voice, sessions, repaintList: () => renderListUi() });

const sessionListView = createSessionListView({
  sessionList: $("sessionList"),
  homeSessionList: $("homeSessionList"),
});

function showMeta() { renderMeta({ sttLabel: voice.sttLabel, prefLanguage }); }

function renderListUi() {
  sessionListView.render({
    items: appState.list,
    currentId: activeId(),
    loading: appState.loading,
    loadingKind: appState.loadingKind,
  });
}

/** Disable the composer while a turn is streaming or a conversation is opening. */
function syncComposerBusy() {
  const turnBusy = Boolean(appState.loading && appState.loadingKind === "turn");
  const busy = turnBusy || Boolean(appState.loading && appState.loadingKind === "open");
  textInput.disabled = busy;
  const sendBtn = $("sendBtn");
  if (sendBtn) {
    sendBtn.disabled = busy;
    sendBtn.textContent = turnBusy ? "Wartet…" : "Senden";
  }
  const hint = $("composerHint");
  if (hint) {
    hint.hidden = !turnBusy;
    if (turnBusy) hint.textContent = "Antwort wird verarbeitet… Mic = Abbrechen";
  }
  if (turnBusy) textInput.placeholder = "Einen Moment…";
  else if (!textInput.value) textInput.placeholder = "Antwort schreiben…";
}

/** Identifies "what the chat area should show"; the chat is only rebuilt when this changes. */
let lastPaintedChatKey = "";
function chatPaintKey() {
  if (isPicker()) return "picker";
  const s = activeSession();
  if (s) return `${s.id}:${s.turn_index}:${(s.messages || []).length}:${s.finalized ? 1 : 0}`;
  if (appState.loading && appState.sessionId) return `loading:${appState.sessionId}`;
  return "empty";
}

function renderView() {
  const picking = isPicker();
  appEl.classList.toggle("picking", picking);
  appEl.classList.toggle("is-loading", Boolean(appState.loading));
  appEl.dataset.loadingKind = appState.loadingKind || "";
  $("chatHome").hidden = !picking;
  const key = chatPaintKey();
  if (key !== lastPaintedChatKey) {
    lastPaintedChatKey = key;
    if (picking) {
      chat.renderChat(null);
      renderSlots(null);
    } else if (key.startsWith("loading:")) {
      qaList.innerHTML = `<p class="lead">Gespräch wird geladen…</p>`;
      // Keep the previous dossier painted unless we are switching away from a loaded session.
      if (!activeSession()) renderSlots(null);
    } else {
      chat.renderChat(activeSession());
      renderSlots(activeSession());
    }
  } else if (!picking && activeSession()) {
    renderSlots(activeSession());
  }
  proposals.render(isPicker() ? null : activeSession());
  renderListUi();
  syncComposerBusy();
  showMeta();
}

subscribe(() => {
  syncUrl();
  renderView();
});

/** Load labels, settings and sessions, then open the right screen. */
async function boot() {
  try {
    await loadDossierSchema();
    await configEditor.load();
    try {
      const health = await api("/health");
      voice.setProviders(Array.isArray(health.stt_providers) && health.stt_providers.length
        ? health.stt_providers
        : [health.stt || "browser"]);
      if (prefs.stt === "auto" || !prefs.stt) prefs.stt = health.stt || voice.resolveSttProvider();
      voice.applySttProvider();
      settings.syncToneUi();
    } catch {
      voice.setProviders(["browser"]);
      voice.useBrowser();
    }
    const list = await sessions.refreshPicker();
    const fromUrl = readUrlSessionId();
    if (fromUrl && list.some((item) => item.id === fromUrl)) await sessions.openSession(fromUrl);
    else if (list.length) sessions.goPicker();
    else await sessions.startSession();
  } catch (err) { voice.setStatus(String(err.message || err)); }
}

settings.paint();
settings.bind();
sessions.bind();
chat.bind();
configEditor.bind();
dossierActions.bind();
proposals.bind();
boot();
