/** User preferences persisted in localStorage. */

import { clamp01, clampSpeed } from "../../shared/format.js";

const PREFS_KEY = "startupVoicePrefs";

const DEFAULTS = {
  lang: "de-DE", voice: true, speed: 1, auto: false, theme: "light",
  nav: "top", dossier: "below", main: "classic",
  stt: "auto", stability: 0.45, similarity: 0.75,
  prefsOpen: true,
};

function readStored() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}

export const prefs = Object.assign({}, DEFAULTS, readStored());
prefs.speed = clampSpeed(prefs.speed);
prefs.stability = clamp01(prefs.stability, 0.45);
prefs.similarity = clamp01(prefs.similarity, 0.75);

export const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
