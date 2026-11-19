/**
 * Prefs feature (browser) - settings bar + layout icon toggles.
 * Everything here is localStorage only; NO backend request.
 *
 * CONTROL -> EFFECT
 * =================
 * [Einstellungen]       #prefsToggle    show/hide the settings bar
 * STT / TTS             #prefsBar       read by voice.js on next use
 * Language DE/EN        #langSel        TOPBAR (prefs + active session via onLanguageChange)
 * Theme + Dossier       .layout-toggles in the TOPBAR (first row)
 * Sidebar open/closed   #sidebarToggle  (topbar, left of the logo)
 * (Hero layout is fixed — no compact/main switch.)
 */

import { api } from "../../shared/api.js";
import { clamp01, clampSpeed, fmt01 } from "../../shared/format.js";
import { modelManager } from "../../shared/model-manager.js";
import { applyChromeI18n } from "./chrome-i18n.js";
import { describeLlm, describeStt } from "./tech-status.js";
import { isBrowserLlm, prefs, savePrefs } from "./prefs.js";

/** @param {{voice: object, onMetaChange: () => void, onLanguageChange?: (lang: string) => void | Promise<void>}} deps */
export function createSettings({ voice, onMetaChange, onLanguageChange }) {
  const $ = (id) => document.getElementById(id);
  const appEl = $("app");
  const themeMq = window.matchMedia("(prefers-color-scheme: dark)");
  /** @type {{destroy:()=>void}|null} */
  let whisperCard = null;
  /** @type {{destroy:()=>void}|null} */
  let llmCard = null;
  /** @type {{destroy:()=>void}|null} */
  let ttsCard = null;

  function applyTheme() {
    const dark = prefs.theme === "dark" || (prefs.theme === "system" && themeMq.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }

  function applyLayout() {
    if (prefs.sidebarOpen === undefined) prefs.sidebarOpen = false;
    appEl.classList.toggle("layout-dossier-below", prefs.dossier === "below");
    appEl.classList.toggle("layout-dossier-side", prefs.dossier === "side");
    appEl.classList.add("layout-main-classic");
    appEl.classList.remove("layout-main-compact");
    appEl.classList.toggle("sidebar-collapsed", !prefs.sidebarOpen);
    appEl.classList.toggle("prefs-collapsed", !prefs.prefsOpen);
    $("prefsToggle")?.setAttribute("aria-expanded", String(Boolean(prefs.prefsOpen)));
    const sideToggle = $("sidebarToggle");
    if (sideToggle) {
      sideToggle.setAttribute("aria-expanded", String(Boolean(prefs.sidebarOpen)));
      sideToggle.title = prefs.sidebarOpen ? "Collapse sidebar" : "Expand sidebar";
      sideToggle.setAttribute("aria-label", sideToggle.title);
    }
    const topPick = $("topSessionPickWrap");
    if (topPick) topPick.hidden = Boolean(prefs.sidebarOpen);
    fitHeader();
  }

  /** Keep the topbar on one line: drop the session select when it overflows. */
  let fittingHeader = false;
  function fitHeader() {
    if (fittingHeader) return;
    const bar = $("topbar");
    const pick = $("topSessionPickWrap");
    if (!bar) return;
    fittingHeader = true;
    try {
      const narrow = window.matchMedia("(max-width: 720px)").matches;
      if (!pick || pick.hidden || narrow) {
        bar.classList.remove("topbar--overflow");
        return;
      }
      bar.classList.remove("topbar--overflow");
      bar.classList.toggle("topbar--overflow", bar.scrollWidth > bar.clientWidth + 1);
    } finally {
      fittingHeader = false;
    }
  }

  function syncVoiceDeps() {
    const deps = $("voiceDeps");
    deps.disabled = !prefs.voice;
    deps.title = prefs.voice ? "" : "Nur mit „Antworten laut vorlesen“ / only with “Read replies aloud”";
  }

  function releaseIfActive(slotKey) {
    const st = modelManager.getState(slotKey)?.state;
    if (st === "downloading" || st === "warming_up" || st === "checking_cache") {
      void modelManager.cancel(slotKey).catch(() => {});
    }
    if (st === "ready" || st === "running") {
      void modelManager.dispose(slotKey).catch(() => {});
    }
  }

  function syncToneUi() {
    [["stability", "stabilityRange", "stabilityVal"], ["similarity", "similarityRange", "similarityVal"]]
      .forEach(([key, rangeId, valId]) => {
        if (!$(rangeId)) return;
        $(rangeId).value = String(Math.round(prefs[key] * 100));
        $(valId).textContent = fmt01(prefs[key]);
        $(rangeId).closest("label")?.toggleAttribute("hidden", prefs.tts !== "elevenlabs");
      });
  }

  /** Plain-language status under the STT / LLM dropdowns (what is active, what is still loading). */
  function syncTechStatus() {
    const lang = prefs.lang || "de";
    const llmEl = $("llmStatus");
    if (llmEl) {
      const st = modelManager.getState("llm");
      llmEl.textContent = describeLlm({ llm: prefs.llm, state: st.state, progress: st.progress, lang });
    }
    const sttEl = $("sttStatus");
    if (sttEl) {
      const st = modelManager.getState("whisper");
      const stt = !prefs.stt || prefs.stt === "auto" ? "browser" : prefs.stt;
      sttEl.textContent = describeStt({ stt, state: st.state, progress: st.progress, lang });
    }
  }
  modelManager.subscribe((slot) => { if (slot === "llm" || slot === "whisper") syncTechStatus(); });

  function syncModelCards() {
    const whisperSlot = $("whisperModelSlot");
    const llmSlot = $("llmModelSlot");
    const ttsSlot = $("ttsModelSlot");
    const stt = prefs.stt === "whisper";
    const llm = isBrowserLlm(prefs.llm);
    const ttsLocal = prefs.tts === "local" || prefs.tts === "transformers";
    if (whisperSlot) {
      whisperSlot.hidden = !stt;
      if (stt && !whisperCard) whisperCard = modelManager.createModelCard(whisperSlot, "whisper");
      if (!stt) {
        releaseIfActive("whisper");
        if (whisperCard) {
          whisperCard.destroy();
          whisperCard = null;
        }
      }
    }
    if (llmSlot) {
      llmSlot.hidden = !llm;
      if (llm) {
        const modelKey = prefs.llm === "gemma-3n-e2b" ? "gemma-3n-e2b" : "granite-3b";
        void modelManager.setLlmModelKey(modelKey).catch(() => {});
        if (!llmCard) llmCard = modelManager.createModelCard(llmSlot, "llm");
      } else {
        releaseIfActive("llm");
        if (llmCard) {
          llmCard.destroy();
          llmCard = null;
        }
      }
    }
    if (ttsSlot) {
      ttsSlot.hidden = !ttsLocal;
      if (ttsLocal) {
        void modelManager.setTtsLanguage(prefs.lang || "de").catch(() => {});
        if (!ttsCard) ttsCard = modelManager.createModelCard(ttsSlot, "tts");
      } else {
        releaseIfActive("tts");
        if (ttsCard) {
          ttsCard.destroy();
          ttsCard = null;
        }
      }
    }
  }

  function paint() {
    syncTechStatus();
    $("langSel").value = prefs.lang;
    $("voiceOn").checked = prefs.voice;
    if ($("cuesOn")) $("cuesOn").checked = prefs.cues !== false;
    if ($("voiceSpeedSel")) $("voiceSpeedSel").value = String(clampSpeed(prefs.speed));
    $("autoListen").checked = prefs.auto;
    const sttSel = $("sttSel");
    if (sttSel && prefs.stt && prefs.stt !== "auto") sttSel.value = prefs.stt;
    const ttsSel = $("ttsSel");
    if (ttsSel) {
      const v = prefs.tts === "transformers" ? "local" : (prefs.tts || "local");
      ttsSel.value = [...ttsSel.options].some((o) => o.value === v) ? v : "local";
    }
    const llmSel = $("llmSel");
    if (llmSel) {
      const v = prefs.llm === "transformers" ? "granite-3b" : prefs.llm;
      llmSel.value = [...llmSel.options].some((o) => o.value === v) ? v : "ollama";
    }
    const ar = $("autoResolveMinSel");
    if (ar) {
      const v = String(prefs.autoResolveMin);
      ar.value = [...ar.options].some((o) => o.value === v) ? v : "0.75";
    }
    syncToneUi();
    syncVoiceDeps();
    syncModelCards();
    applyTheme();
    applyLayout();
    syncToggles();
    applyChromeI18n(prefs.lang);
  }

  /** Icon toggles: show only the icon of the current value; title says what a click does. */
  function syncToggles() {
    document.querySelectorAll(".icon-toggle").forEach((btn) => {
      const key = btn.dataset.pref;
      const spans = [...btn.querySelectorAll("[data-v]")];
      let cur = prefs[key];
      if (key === "theme" && cur === "system") cur = themeMq.matches ? "dark" : "light";
      if (!spans.some((el) => el.dataset.v === cur)) cur = spans[0]?.dataset.v;
      const here = spans.find((el) => el.dataset.v === cur) || spans[0];
      const other = spans.find((el) => el !== here);
      spans.forEach((el) => { el.hidden = el !== here; });
      if (here && other) btn.title = `${here.dataset.title} — click for ${other.dataset.title}`;
    });
  }

  function flipToggle(btn) {
    const key = btn.dataset.pref;
    const values = [...btn.querySelectorAll("[data-v]")].map((el) => el.dataset.v);
    let cur = prefs[key];
    if (key === "theme" && cur === "system") cur = themeMq.matches ? "dark" : "light";
    prefs[key] = values[(Math.max(0, values.indexOf(cur)) + 1) % values.length];
    savePrefs();
    if (key === "theme") applyTheme();
    else applyLayout();
    syncToggles();
  }

  function setSidebarOpen(open) {
    prefs.sidebarOpen = Boolean(open);
    savePrefs();
    applyLayout();
  }

  /**
   * Voice mode = the two big cards ("Antippen & sprechen" / "Live-Gespräch"). The hidden
   * #voiceModeSel mirrors them. A mode the server has not configured shows a friendly badge;
   * the technical reason (missing LIVEKIT_* …) goes to the Technik fold, not in the founder's face.
   */
  async function syncVoiceModeUi() {
    let transports = [];
    try { transports = (await api("/api/voice/transports")).transports || []; } catch { /* offline: classic only */ }
    const current = voice.getMode();
    const sel = $("voiceModeSel");
    if (sel) sel.value = current;
    const tech = [];
    document.querySelectorAll(".mode-card[data-mode]").forEach((card) => {
      const mode = card.dataset.mode;
      const ok = mode === "classic" || voice.isAvailable(mode);
      card.setAttribute("aria-checked", String(mode === current));
      card.setAttribute("aria-disabled", String(!ok));
      card.classList.toggle("is-unavailable", !ok);
      if (!ok) tech.push(`${mode}: ${transports.find((x) => x.name === mode)?.reason || "not available"}`);
    });
    const badge = $("modeLiveBadge");
    if (badge) badge.hidden = voice.isAvailable("livekit");
    const techEl = $("voiceModeTech");
    if (techEl) {
      techEl.hidden = !tech.length;
      techEl.textContent = tech.length ? `Unavailable — ${tech.join(" · ")}` : "";
    }
  }

  function chooseVoiceMode(mode) {
    if (mode !== "classic" && !voice.isAvailable(mode)) return; // "Noch nicht eingerichtet"
    prefs.voiceMode = mode;
    savePrefs();
    voice.refresh(); // ends a running call, hands over to the other driver
    void syncVoiceModeUi();
    onMetaChange?.();
  }

  function bindPref(id, event, read, key, after) {
    $(id)?.addEventListener(event, () => {
      prefs[key] = read($(id));
      savePrefs();
      after?.();
    });
  }

  function bind() {
    themeMq.addEventListener("change", () => { applyTheme(); syncToggles(); });
    $("prefsToggle")?.addEventListener("click", () => {
      prefs.prefsOpen = !prefs.prefsOpen;
      savePrefs();
      applyLayout();
    });
    $("sidebarToggle")?.addEventListener("click", () => setSidebarOpen(!prefs.sidebarOpen));
    $("langSel")?.addEventListener("change", async () => {
      prefs.lang = $("langSel").value;
      savePrefs();
      applyChromeI18n(prefs.lang);
      if (prefs.tts === "local" || prefs.tts === "transformers") {
        void modelManager.setTtsLanguage(prefs.lang).catch(() => {});
      }
      try {
        await onLanguageChange?.(prefs.lang);
      } finally {
        onMetaChange?.();
      }
    });
    document.querySelectorAll(".mode-card[data-mode]").forEach((card) => {
      card.addEventListener("click", () => chooseVoiceMode(card.dataset.mode));
    });
    // Arrow keys move between the two cards (radiogroup behaviour).
    document.querySelector(".mode-cards")?.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const cards = [...document.querySelectorAll(".mode-card[data-mode]")];
      const i = cards.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = cards[(i + (e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1) + cards.length) % cards.length];
      next.focus();
      chooseVoiceMode(next.dataset.mode);
    });
    bindPref("sttSel", "change", (e) => e.value, "stt", () => {
      voice.applySttProvider();
      syncModelCards();
      syncTechStatus();
      onMetaChange?.();
    });
    bindPref("ttsSel", "change", (e) => e.value, "tts", () => {
      syncModelCards();
      syncToneUi();
      onMetaChange?.();
    });
    bindPref("llmSel", "change", (e) => e.value, "llm", () => {
      syncModelCards();
      syncTechStatus();
      onMetaChange?.();
    });
    bindPref("voiceOn", "change", (e) => e.checked, "voice", () => {
      syncVoiceDeps();
      if (!prefs.voice) voice.stopSpeak();
    });
    bindPref("cuesOn", "change", (e) => e.checked, "cues");
    bindPref("voiceSpeedSel", "change", (e) => clampSpeed(e.value), "speed");
    ["stability", "similarity"].forEach((key) => {
      bindPref(`${key}Range`, "input", (e) => clamp01(Number(e.value) / 100), key, () => {
        $(`${key}Val`).textContent = fmt01(prefs[key]);
      });
    });
    bindPref("autoListen", "change", (e) => e.checked, "auto");
    bindPref("autoResolveMinSel", "change", (e) => Number(e.value), "autoResolveMin");
    document.querySelectorAll(".icon-toggle").forEach((btn) => {
      btn.addEventListener("click", () => flipToggle(btn));
    });
    const bar = $("topbar");
    if (bar && window.ResizeObserver) {
      const ro = new ResizeObserver(() => fitHeader());
      ro.observe(bar);
    } else {
      window.addEventListener("resize", () => fitHeader());
    }
    const banner = $("processBanner");
    if (banner && window.MutationObserver) {
      new MutationObserver(() => fitHeader()).observe(banner, {
        attributes: true,
        attributeFilter: ["hidden", "class"],
      });
    }
    window.addEventListener("resize", () => fitHeader());
  }

  return { paint, bind, syncToneUi, applyLayout, syncVoiceModeUi };
}
