/** User preferences persisted in localStorage. */

import { clamp01, clampSpeed } from "../../shared/format.js";

const PREFS_KEY = "startupVoicePrefs";
/** Bump when defaults for chrome layout change so old localStorage picks them up once. */
const PREFS_VERSION = 3;

const DEFAULTS = {
  lang: "de-DE", voice: true, speed: 1, auto: false, theme: "light",
  dossier: "below",
  sidebarOpen: false, // sessions rail collapsed by default; expand via topbar
  stt: "auto",
  /** "" = follow the server's VOICE_MODE; "classic" = push-to-talk; "livekit" = hands-free call */
  voiceMode: "",
  /** short signal tones in a hands-free call (your turn / got it / call ended) */
  cues: true,
  /** local = downloadable Transformers.js TTS (default); browser = Web Speech; elevenlabs = cloud */
  tts: "local",
  stability: 0.45, similarity: 0.75,
  /** ollama = server LLM; transformers = browser WebGPU via Transformers.js */
  llm: "ollama",
  prefsOpen: false, // settings bar collapsed by default
  /** Auto-accept incoming conflicts when confidence >= this (1.01 = off). */
  autoResolveMin: 0.75,
  _v: PREFS_VERSION,
};

function readStored() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
}

const stored = readStored();
// One-shot: adopt collapsed settings + sidebar defaults (ignore previous open chrome).
if (stored._v !== PREFS_VERSION) {
  delete stored.prefsOpen;
  delete stored.sidebarOpen;
  if (!stored.tts) stored.tts = "local";
  stored._v = PREFS_VERSION;
}

export const prefs = Object.assign({}, DEFAULTS, stored);
// Hero layout is fixed — drop legacy compact/main toggles from older localStorage.
delete prefs.main;
prefs.speed = clampSpeed(prefs.speed);
prefs.stability = clamp01(prefs.stability, 0.45);
prefs.similarity = clamp01(prefs.similarity, 0.75);
{
  const n = Number(prefs.autoResolveMin);
  prefs.autoResolveMin = Number.isFinite(n) ? n : 0.75;
}
const BROWSER_LLM_VALUES = new Set(["granite-3b", "gemma-3n-e2b", "transformers"]);
if (prefs.llm === "transformers") prefs.llm = "granite-3b";
if (!BROWSER_LLM_VALUES.has(prefs.llm) && prefs.llm !== "ollama") prefs.llm = "ollama";
if (!["", "classic", "livekit"].includes(prefs.voiceMode)) prefs.voiceMode = "";
if (prefs.tts === "transformers") prefs.tts = "local";
if (!["local", "browser", "elevenlabs"].includes(prefs.tts)) prefs.tts = "local";
prefs._v = PREFS_VERSION;

export const isBrowserLlm = (v = prefs.llm) => BROWSER_LLM_VALUES.has(v);
export const savePrefs = () => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
savePrefs(); // persist cleaned prefs (drops stale `main`)
