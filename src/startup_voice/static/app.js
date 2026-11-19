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
  appState, activeId, activeSession, clearProcessBusy, confirmInterruptProcess, isPicker,
  setProcessBusy, subscribe,
} from "./shared/state.js";
import { createVoice } from "./features/voice/voice.js";
import { createLiveKitVoice } from "./features/voice/voice-livekit.js";
import { createVoiceSwitch } from "./features/voice/voice-mode.js";
import { createMicListener, resampleTo16k } from "./features/voice/browser-listen.js";
import { applyAvailability } from "./features/prefs/availability.js";
import { createWebSpeechListener, isWebSpeechSupported } from "./features/voice/web-speech-listen.js";
import { createCues } from "./features/voice/cues.js";
import { createIdoBridge } from "./features/ido/ido-bridge.js";
import { createPublishDialog } from "./features/board/publish.js";
import { createHomeBoard } from "./features/board/home-board.js";
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
const voiceDeps = {
  prefs,
  getLanguage: currentLanguage,
  canListen: () => !isPicker() && Boolean(activeSession()),
  onTranscript: (text) => chat.sendText(text),
  // Mic during thinking / cancel: abort the in-flight turn SSE (shows Wiederholen).
  // Speak during dossier extract must NOT abort Call #2.
  onAbort: () => chat.abortTurn({ keepExtract: true }),
  confirmInterrupt: () => confirmInterruptProcess(currentLanguage()),
};

/*
 * VOICE MODES — two interchangeable drivers behind ONE `voice` object (voice-mode.js):
 *   classic  push-to-talk in the browser (voice.js)      always available, the fallback
 *   livekit  hands-free call with a server voice worker  (voice-livekit.js; needs LIVEKIT_* in .env)
 * Both end in the same onTranscript -> chat.sendText path. The mode is Settings > Voice mode
 * (prefs.voiceMode); "" follows the server's VOICE_MODE. Everything below talks to `voice` only.
 */
const classicVoice = createVoice({
  ...voiceDeps,
  textInput,
  onProviderChange: () => showMeta(),
});
const livekitVoice = createLiveKitVoice({
  ...voiceDeps,
  api,
  base: classicVoice,
  getSessionId: activeId,
  cues: createCues({ isEnabled: () => prefs.cues !== false }),
  // Settings > STT = "Whisper (Browser)": in a call the browser transcribes (local Transformers.js
  // Whisper) and the worker only speaks. Any other STT choice: the worker listens.
  browserStt: {
    isEnabled: () => prefs.stt === "whisper",
    prepare: () => modelManager.ensureLoaded("whisper"),
    createListener: createMicListener,
    transcribe: (samples, rate, lang) => modelManager.transcribe(resampleTo16k(samples, rate), lang),
  },
  // Settings > STT = "Browser (Web Speech)": the browser's own recognizer, no download.
  webSpeech: {
    isSupported: () => isWebSpeechSupported(),
    isEnabled: () => prefs.stt === "browser" && isWebSpeechSupported(),
    create: createWebSpeechListener,
  },
});
let serverVoiceMode = "classic";
const voice = createVoiceSwitch({
  drivers: { classic: classicVoice, livekit: livekitVoice },
  getPreferred: () => prefs.voiceMode,
  getServerDefault: () => serverVoiceMode,
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
const dossierActions = createDossierActions({
  voice, sessions, chat, repaintList: () => renderListUi(),
});

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
  const dosUpdBtn = $("dossierUpdateNowBtn");
  const s = activeSession();
  const focusSlots = Array.isArray(s?.evaluation?.next_focus_slots)
    ? s.evaluation.next_focus_slots
    : [];
  const missingCount = Array.isArray(s?.evaluation?.missing_fields)
    ? s.evaluation.missing_fields.length
    : 0;
  const isComplete100 = Boolean(
    s
    && (s.evaluation?.ready_for_closing
      || Number(s.evaluation?.field_coverage || 0) >= 1
      || missingCount === 0),
  );
  const isAlmostDone = Boolean(
    s
    && !s.finalized
    && !isComplete100
    && (focusSlots.length === 1 || (missingCount >= 1 && missingCount <= 2)),
  );
  const isExtractingThisSession = Boolean(
    p && p.kind === "extract" && (!activeId() || p.sessionId === activeId()),
  );
  if (dosUpd) {
    if (isExtractingThisSession) {
      dosUpd.hidden = false;
      dosUpd.dataset.mode = "updating";
      if (dosUpdBtn) dosUpdBtn.hidden = true;
      if (dosUpdText) {
        const soonBit = isAlmostDone
          ? (de ? " · Fast fertig (letztes offenes Feld)!" : " · Almost done (final open topic)!")
          : "";
        dosUpdText.textContent = (de
          ? "Dossier wird im Hintergrund aktualisiert — Sie können schon weitersprechen (neue Antwort wartet automatisch kurz aufs Update)"
          : "Updating dossier in background — feel free to speak now (your next reply waits automatically for the update)")
          + soonBit;
      }
    } else if (isComplete100) {
      dosUpd.hidden = false;
      dosUpd.dataset.mode = "complete";
      const vCount = Array.isArray(s?.dossier_versions) ? s.dossier_versions.length : 0;
      if (dosUpdText) {
        dosUpdText.textContent = de
          ? `100% vollständig — Dossier bereit zum Speichern (v${vCount + 1}) oder Abschließen.`
          : `100% complete — dossier is ready to save (v${vCount + 1}) or wrap up.`;
      }
      if (dosUpdBtn) {
        dosUpdBtn.hidden = false;
        dosUpdBtn.textContent = de ? `Als v${vCount + 1} speichern` : `Save as v${vCount + 1}`;
        dosUpdBtn.dataset.act = "finalize";
      }
    } else if (isAlmostDone) {
      dosUpd.hidden = false;
      dosUpd.dataset.mode = "almost-done";
      const lastSlot = focusSlots[0] || "";
      if (dosUpdText) {
        dosUpdText.textContent = de
          ? `Fast fertig — nur noch 1 Bereich offen (${lastSlot || `${missingCount} Feld`}). Nach dieser Antwort ist das Dossier bereit zum Abschließen.`
          : `Almost done — only 1 topic left (${lastSlot || `${missingCount} field`}). After this answer your dossier is ready to wrap up.`;
      }
      if (dosUpdBtn) {
        dosUpdBtn.hidden = false;
        dosUpdBtn.textContent = de ? "Dossier aktualisieren" : "Update dossier";
        dosUpdBtn.dataset.act = "extract";
      }
    } else {
      dosUpd.hidden = true;
      if (dosUpdBtn) dosUpdBtn.hidden = true;
      delete dosUpd.dataset.mode;
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
        ? "Dossier aktualisiert im Hintergrund — Sie können bereits sprechen oder schreiben."
        : "Updating dossier in background — you can already speak or type.";
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
  $("homeBoard").hidden = !picking;
  $("homeRow").hidden = !picking;
  if (picking) void homeBoard.refresh();
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

/** Public Idea Board: publish parts of the dossier (features/board). Nothing is public until the founder does it. */
const homeBoard = createHomeBoard({ api, getLanguage: currentLanguage });
const publishDialog = createPublishDialog({ api, getSessionId: activeId, getLanguage: currentLanguage });
publishDialog.bind();

/** Only does anything when this page runs inside ido-core's iframe (see features/ido). */
const idoBridge = createIdoBridge({
  api,
  getSessionId: activeId,
  onNotice: (text) => voice.setStatus(text),
});

subscribe(() => {
  syncUrl();
  renderView();
  idoBridge.onStateChange();
  voice.onSessionChange(); // a live call belongs to ONE session: end it when the session changes
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
  // Capture ?s=<id> BEFORE goPicker() (goPicker triggers syncUrl which strips ?s=).
  const initialUrlSessionId = readUrlSessionId();
  sessions.goPicker({ status: "Loading sessions…" });
  try {
    await loadDossierSchema();
    await configEditor.load();
    try {
      const health = await api("/health");
      voice.setProviders(Array.isArray(health.stt_providers) && health.stt_providers.length
        ? health.stt_providers
        : [health.stt || "browser"]);
      // Default = the browser's own recognizer (Whisper where Web Speech is missing). A cloud provider
      // is only used when the founder picked it AND the server still offers it (key + credits).
      const localStt = isWebSpeechSupported() ? "browser" : "whisper";
      const providers = Array.isArray(health.stt_providers) ? health.stt_providers : [];
      const isCloud = (v) => v === "elevenlabs" || v === "deepgram";
      if (prefs.stt === "auto" || !prefs.stt) {
        const server = health.stt;
        prefs.stt = (server && server !== "browser" && isCloud(server)) ? server : localStt;
        savePrefs();
      } else if (isCloud(prefs.stt) && !providers.includes(prefs.stt)) {
        prefs.stt = localStt; // chosen earlier, but out of credits / no key now
        savePrefs();
      }
      if (applyAvailability({ prefs, health, hostname: location.hostname })) { savePrefs(); settings.paint(); }
      voice.applySttProvider();
      settings.syncToneUi();
      serverVoiceMode = health.voice_mode || "classic";
      voice.setAvailableModes(health.voice_modes);
      void settings.syncVoiceModeUi();
    } catch {
      voice.setProviders(["browser"]);
      if (prefs.stt === "auto" || !prefs.stt) {
        prefs.stt = "browser";
        savePrefs();
      }
      voice.applySttProvider();
    }
    const list = await sessions.refreshPicker();
    const fromUrl = initialUrlSessionId || readUrlSessionId();
    if (fromUrl && list.some((item) => item.id === fromUrl)) await sessions.openSession(fromUrl);
    else sessions.goPicker();
  } catch (err) {
    voice.setStatus(String(err.message || err));
    sessions.goPicker({ status: String(err.message || err).slice(0, 120) });
  }
}

void idoBridge.start();
settings.paint();
settings.bind();
sessions.bind();
chat.bind({ onEndClose: () => dossierActions.endAndClose() });
configEditor.bind();
dossierActions.bind();
proposals.bind();
renderView();
boot();
