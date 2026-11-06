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
import { modelManager } from "./shared/model-manager.js";
import {
  appState, activeId, activeSession, clearProcessBusy, confirmInterruptProcess, isPicker, nav,
  setProcessBusy, subscribe,
} from "./shared/state.js";
import { createVoice } from "./features/voice/voice.js";
import { prefs, savePrefs } from "./features/prefs/prefs.js";
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
import { applyChromeI18n, t } from "./features/prefs/chrome-i18n.js";

const $ = (id) => document.getElementById(id);
const appEl = $("app");
const qaList = $("qaList");
const textInput = $("textInput");

/** Pref / header #langSel (BCP-47 → "de"|"en"). Active session language wins for STT/TTS/reply. */
const prefLanguage = () => String(prefs.lang).slice(0, 2);
const currentLanguage = () => activeSession()?.language || prefLanguage();

/*
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  VOICE → AI HAND-OFF (the one line that connects ears to brain)          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * voice.js = STT/TTS only. It never imports chat.js and never hits /turn*.
 * We inject `onTranscript` so a finished mic transcript becomes the SAME
 * sendText(text) path as typing into the box:
 *
 *   mic → voice.js (STT) → onTranscript(text) → chat.sendText(text)
 *                                              → POST .../turn/stream → LLM
 *
 * Change what happens after speech HERE — not inside voice.js.
 */
const voice = createVoice({
  prefs,
  textInput,
  getLanguage: currentLanguage,
  canListen: () => !isPicker() && Boolean(activeSession()),
  onTranscript: (text) => chat.sendText(text),
  onProviderChange: () => showMeta(),
  // Mic during thinking / cancel: abort the in-flight turn SSE (shows Wiederholen).
  onAbort: () => chat.abortTurn(),
  confirmInterrupt: () => confirmInterruptProcess(currentLanguage()),
});

const sessions = createSessions({
  voice,
  prefLanguage,
  onInterrupt: () => chat.abortTurn(),
});
const chat = createChat({ voice, sessions });
const configEditor = createConfigEditor({ sessions });
const settings = createSettings({
  voice,
  onMetaChange: () => showMeta(),
  onLanguageChange: async (langBcp47) => {
    const s = activeSession();
    if (!s) return;
    const updated = await api(`/api/sessions/${s.id}`, {
      method: "PATCH",
      body: JSON.stringify({ language: langBcp47 }),
    });
    sessions.patchActiveSession(updated);
  },
});
const proposals = createProposals({ voice, sessions });
const dossierActions = createDossierActions({ voice, sessions, repaintList: () => renderListUi() });

const sessionListView = createSessionListView({
  sessionList: $("sessionList"),
  homeSessionList: $("homeSessionList"),
  sessionPick: $("sessionPick"),
});

function showMeta() {
  applyChromeI18n(currentLanguage());
  renderMeta({ sttLabel: voice.sttLabel, prefLanguage });
}

/** Topbar process strip + Live Dossier updating notice. */
function paintProcessBanner() {
  const el = $("processBanner");
  const p = appState.processBusy;
  const lang = currentLanguage();
  const de = String(lang).startsWith("de");

  // Sync the inline notice right under "Live dossier / Session … · Turn N"
  const dosUpd = $("dossierUpdating");
  const dosUpdText = $("dossierUpdatingText");
  const isExtractingThisSession = Boolean(
    p && p.kind === "extract" && (!activeId() || p.sessionId === activeId()),
  );
  if (dosUpd) {
    dosUpd.hidden = !isExtractingThisSession;
    if (isExtractingThisSession && dosUpdText) {
      dosUpdText.textContent = de
        ? "Dossier wird gerade aktualisiert — am besten kurz warten, bevor Sie weitersprechen/senden (sonst stellt der Agent evtl. dieselbe Frage erneut)."
        : "Updating dossier right now — best wait a moment before speaking or sending (interrupting may cause the agent to ask the same question again).";
    }
  }

  if (!el) return;
  if (!p) {
    el.hidden = true;
    el.classList.remove("is-on");
    el.removeAttribute("data-kind");
    el.setAttribute("aria-busy", "false");
    return;
  }
  const fallback = {
    extract: t("updatingDossier", lang),
    turn: t("thinking", lang),
    open: t("loadingSession", lang),
    finalize: t("finalizingDossier", lang),
    model: "Loading model…",
  }[p.kind] || t("thinking", lang);
  const label = $("processBannerLabel");
  const sessionEl = $("processBannerSession");
  if (label) label.textContent = p.message || fallback;
  if (sessionEl) {
    sessionEl.textContent = p.label
      ? (de ? `Gespräch: ${p.label}` : `Session: ${p.label}`)
      : "";
  }
  el.dataset.kind = p.kind || "";
  el.hidden = false;
  el.classList.add("is-on");
  el.setAttribute("aria-busy", "true");
}

function renderListUi() {
  sessionListView.render({
    items: appState.list,
    currentId: activeId(),
    loading: appState.loading,
    loadingKind: appState.loadingKind,
    processBusy: appState.processBusy,
  });
}

/** Disable the composer while a turn is streaming or a conversation is opening. */
function syncComposerBusy() {
  const turnBusy = Boolean(appState.loading && appState.loadingKind === "turn");
  const extractBusy = Boolean(
    appState.processBusy
    && appState.processBusy.kind === "extract"
    && appState.processBusy.sessionId === activeId(),
  );
  const busy = turnBusy || Boolean(appState.loading && appState.loadingKind === "open");
  textInput.disabled = busy;
  const sendBtn = $("sendBtn");
  const de = currentLanguage().startsWith("de");
  if (sendBtn) {
    sendBtn.disabled = busy;
    sendBtn.textContent = turnBusy
      ? (de ? "Wartet…" : "Waiting…")
      : (de ? "Senden" : "Send");
  }
  const hint = $("composerHint");
  if (hint) {
    if (turnBusy) {
      hint.hidden = false;
      if (!hint.dataset.live) {
        hint.textContent = de
          ? "Antwort wird generiert… Bitte kurz warten."
          : "Generating reply… Please wait.";
      }
    } else if (extractBusy) {
      hint.hidden = false;
      delete hint.dataset.live;
      hint.textContent = de
        ? "Dossier wird aktualisiert — am besten kurz warten (Sprechen/Senden jetzt fragt vor dem Abbruch nach)."
        : "Updating dossier — best wait a moment (speaking/sending now will ask before interrupting).";
    } else {
      hint.hidden = true;
      delete hint.dataset.live;
    }
  }
  if (turnBusy) textInput.placeholder = de ? "Einen Moment…" : "One moment…";
  else if (!textInput.value) {
    textInput.placeholder = de ? "Antwort schreiben…" : "Write a reply…";
  }
}

/** Identifies "what the chat area should show"; the chat is only rebuilt when this changes. */
let lastPaintedChatKey = "";
function chatPaintKey() {
  if (isPicker()) return "picker";
  const s = activeSession();
  if (s) {
    const err = appState.turnError?.sessionId === s.id
      ? `:e:${appState.turnError.message || "1"}`
      : "";
    const trail = !appState.loading
      && (s.messages || []).at(-1)?.role === "user" ? ":u" : "";
    const lastWarn = (s.messages || []).at(-1)?.warning ? `:w:${(s.messages || []).at(-1).warning}` : "";
    return `${s.id}:${s.turn_index}:${(s.messages || []).length}:${s.finalized ? 1 : 0}${err}${trail}${lastWarn}`;
  }
  if (appState.loading && appState.sessionId) return `loading:${appState.sessionId}`;
  return "empty";
}

function renderView() {
  const picking = isPicker();
  appEl.classList.toggle("picking", picking);
  appEl.classList.toggle("is-loading", Boolean(appState.loading));
  appEl.dataset.loadingKind = appState.loadingKind || "";
  if (picking) {
    delete appEl.dataset.offerEnd;
    const end = $("intakeEnd");
    if (end) end.hidden = true;
  }
  $("chatHome").hidden = !picking;
  const heroStart = $("heroStart");
  if (heroStart) heroStart.hidden = !picking;
  const key = chatPaintKey();
  if (key !== lastPaintedChatKey) {
    lastPaintedChatKey = key;
    if (picking) {
      chat.renderChat(null);
      renderSlots(null);
    } else if (key.startsWith("loading:")) {
      qaList.innerHTML = `<p class="lead">Loading session…</p>`;
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
  // Keep Sprechen above conflict cards (qaList wipe must not orphan/destroy it).
  chat.placeSpeakDock?.();
  configEditor.paintFollowupSelect?.();
  renderListUi();
  syncComposerBusy();
  showMeta();
  // After i18n — banner + end/vX hub labels are dynamic (not data-i18n).
  if (!picking) chat.syncIntakeEnd?.(activeSession());
  paintProcessBanner();
}

subscribe(() => {
  syncUrl();
  renderView();
});

// Sync model download / warm-up progress into the topbar process banner.
modelManager.setProcessBannerHook((info) => {
  if (!info?.active) {
    if (appState.processBusy?.kind === "model") clearProcessBusy();
    return;
  }
  // Don't clobber an in-flight turn/extract banner.
  if (appState.processBusy && appState.processBusy.kind !== "model") return;
  const sid = activeId() || "model";
  setProcessBusy({
    kind: "model",
    sessionId: sid,
    message: info.message || "Loading model…",
  });
});

/** Load labels, settings and sessions, then open the right screen. */
async function boot() {
  // Paint picker immediately so Start new chat is never stuck hidden before network returns.
  sessions.goPicker({ status: "Loading sessions…" });
  try {
    await loadDossierSchema();
    await configEditor.load();
    try {
      const health = await api("/health");
      voice.setProviders(Array.isArray(health.stt_providers) && health.stt_providers.length
        ? health.stt_providers
        : [health.stt || "browser"]);
      if (prefs.stt === "auto" || !prefs.stt) {
        // Prefer cloud STT from health; otherwise Whisper (browser) over Web Speech.
        const server = health.stt;
        prefs.stt = (server && server !== "browser") ? server : voice.resolveSttProvider();
        savePrefs();
      }
      voice.applySttProvider();
      settings.syncToneUi();
    } catch {
      voice.setProviders(["browser"]);
      if (prefs.stt === "auto" || !prefs.stt) {
        prefs.stt = "whisper";
        savePrefs();
      }
      voice.applySttProvider();
    }
    const list = await sessions.refreshPicker();
    const fromUrl = readUrlSessionId();
    if (fromUrl && list.some((item) => item.id === fromUrl)) await sessions.openSession(fromUrl);
    else sessions.goPicker();
  } catch (err) {
    voice.setStatus(String(err.message || err));
    sessions.goPicker({ status: String(err.message || err).slice(0, 120) });
  }
}

settings.paint();
settings.bind();
sessions.bind();
chat.bind({ onEndClose: () => dossierActions.endAndClose() });
configEditor.bind();
dossierActions.bind();
proposals.bind();
renderView();
boot();
