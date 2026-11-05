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

import { clamp01, clampSpeed, fmt01 } from "../../shared/format.js";
import { applyChromeI18n } from "./chrome-i18n.js";
import { prefs, savePrefs } from "./prefs.js";

/** @param {{voice: object, onMetaChange: () => void, onLanguageChange?: (lang: string) => void | Promise<void>}} deps */
export function createSettings({ voice, onMetaChange, onLanguageChange }) {
  const $ = (id) => document.getElementById(id);
  const appEl = $("app");
  const themeMq = window.matchMedia("(prefers-color-scheme: dark)");

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
  }

  function syncVoiceDeps() {
    const deps = $("voiceDeps");
    deps.disabled = !prefs.voice;
    deps.title = prefs.voice ? "" : "Only with “Read replies aloud”";
  }

  function syncToneUi() {
    [["stability", "stabilityRange", "stabilityVal"], ["similarity", "similarityRange", "similarityVal"]]
      .forEach(([key, rangeId, valId]) => {
        if (!$(rangeId)) return;
        $(rangeId).value = String(Math.round(prefs[key] * 100));
        $(valId).textContent = fmt01(prefs[key]);
      });
  }

  function paint() {
    $("langSel").value = prefs.lang;
    $("voiceOn").checked = prefs.voice;
    if ($("voiceSpeedSel")) $("voiceSpeedSel").value = String(clampSpeed(prefs.speed));
    $("autoListen").checked = prefs.auto;
    const ar = $("autoResolveMinSel");
    if (ar) {
      const v = String(prefs.autoResolveMin);
      ar.value = [...ar.options].some((o) => o.value === v) ? v : "0.75";
    }
    syncToneUi();
    syncVoiceDeps();
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
      try {
        await onLanguageChange?.(prefs.lang);
      } finally {
        onMetaChange?.();
      }
    });
    bindPref("sttSel", "change", (e) => e.value, "stt", () => {
      voice.applySttProvider();
      onMetaChange?.();
    });
    bindPref("voiceOn", "change", (e) => e.checked, "voice", () => {
      syncVoiceDeps();
      if (!prefs.voice) voice.stopSpeak();
    });
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
  }

  return { paint, bind, syncToneUi, applyLayout };
}
