/**
 * Prefs feature (browser) - the settings bar. Everything here is stored in localStorage only;
 * NO backend request is made by any control in this file.
 *
 * CONTROL -> EFFECT
 * =================
 * [Einstellungen]       #prefsToggle    show/hide the settings bar
 * STT                   #sttSel         which speech-to-text engine the mic uses (voice.applySttProvider)
 * Gesprächssprache      #langSel        language of the NEXT new conversation (open ones keep theirs)
 * Antworten vorlesen    #voiceOn        TTS on/off (off also stops audio that is playing)
 * Tempo / Stabilität / Ähnlichkeit      #voiceSpeedSel #stabilityRange #similarityRange
 *                                       parameters sent with the NEXT POST /api/tts request
 * Weiterhören           #autoListen     re-open the mic after each spoken reply
 * Theme / Main / Nav / Dossier          .icon-toggle[data-pref]  one icon button each, flips between 2 values
 *
 * (System prompt + question catalog are NOT here: they are server-side, see
 *  features/interview/ui/config-editor.js.)
 */

import { clamp01, clampSpeed, fmt01 } from "../../shared/format.js";
import { prefs, savePrefs } from "./prefs.js";

/** @param {{voice: object, onMetaChange: () => void}} deps */
export function createSettings({ voice, onMetaChange }) {
  const $ = (id) => document.getElementById(id);
  const appEl = $("app");
  const themeMq = window.matchMedia("(prefers-color-scheme: dark)");

  function applyTheme() {
    const dark = prefs.theme === "dark" || (prefs.theme === "system" && themeMq.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }

  function applyLayout() {
    appEl.classList.toggle("layout-top", prefs.nav === "top");
    appEl.classList.toggle("layout-side", prefs.nav === "side");
    appEl.classList.toggle("layout-dossier-below", prefs.dossier === "below");
    appEl.classList.toggle("layout-dossier-side", prefs.dossier === "side");
    appEl.classList.toggle("layout-main-classic", prefs.main === "classic");
    appEl.classList.toggle("layout-main-compact", prefs.main === "compact");
    appEl.classList.toggle("prefs-collapsed", !prefs.prefsOpen);
    $("prefsToggle")?.setAttribute("aria-expanded", String(Boolean(prefs.prefsOpen)));
  }

  /** Tempo/tone controls only make sense while "Antworten vorlesen" is on. */
  function syncVoiceDeps() {
    const deps = $("voiceDeps");
    deps.disabled = !prefs.voice;
    deps.title = prefs.voice ? "" : "Nur mit „Antworten vorlesen“";
  }

  function syncToneUi() {
    [["stability", "stabilityRange", "stabilityVal"], ["similarity", "similarityRange", "similarityVal"]]
      .forEach(([key, rangeId, valId]) => {
        if (!$(rangeId)) return;
        $(rangeId).value = String(Math.round(prefs[key] * 100));
        $(valId).textContent = fmt01(prefs[key]);
      });
  }

  /** Put the stored prefs into the controls (call once at boot). */
  function paint() {
    $("langSel").value = prefs.lang;
    $("voiceOn").checked = prefs.voice;
    if ($("voiceSpeedSel")) $("voiceSpeedSel").value = String(clampSpeed(prefs.speed));
    $("autoListen").checked = prefs.auto;
    syncToneUi();
    syncVoiceDeps();
    applyTheme();
    applyLayout();
    syncToggles();
  }

  /** Icon toggles: show only the icon of the current value; title says what a click does. */
  function syncToggles() {
    document.querySelectorAll(".icon-toggle").forEach((btn) => {
      const key = btn.dataset.pref;
      const spans = [...btn.querySelectorAll("[data-v]")];
      let cur = prefs[key];
      if (key === "theme" && cur === "system") cur = themeMq.matches ? "dark" : "light";
      if (!spans.some((el) => el.dataset.v === cur)) cur = spans[0].dataset.v;
      const here = spans.find((el) => el.dataset.v === cur);
      const other = spans.find((el) => el !== here);
      spans.forEach((el) => { el.hidden = el !== here; });
      btn.title = `${here.dataset.title} – klicken für ${other.dataset.title}`;
    });
  }

  function flipToggle(btn) {
    const key = btn.dataset.pref;
    const values = [...btn.querySelectorAll("[data-v]")].map((el) => el.dataset.v);
    let cur = prefs[key];
    if (key === "theme" && cur === "system") cur = themeMq.matches ? "dark" : "light";
    prefs[key] = values[(values.indexOf(cur) + 1) % values.length];
    savePrefs();
    if (key === "theme") applyTheme();
    else applyLayout();
    if (key === "main") onMetaChange();
    syncToggles();
  }

  /** Bind a <select>/<checkbox>/<range> to one pref: store it, then run `after`. */
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
    bindPref("langSel", "change", (e) => e.value, "lang", onMetaChange);
    bindPref("sttSel", "change", (e) => e.value, "stt", () => voice.applySttProvider());
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
    document.querySelectorAll(".icon-toggle").forEach((btn) => {
      btn.addEventListener("click", () => flipToggle(btn));
    });
  }

  return { paint, bind, syncToneUi };
}
