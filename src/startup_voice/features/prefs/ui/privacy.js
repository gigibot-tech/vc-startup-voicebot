/**
 * Privacy lines in the header, stacked on the left of the "Einstellungen" button (TTS / STT / LLM): for each of the three services that touch
 * the founder's words — LLM (text), TTS (voice out), STT (voice in) — where does the data go?
 *
 *   local  green lock   runs on this device (browser model / Whisper / local Ollama): nothing leaves it
 *   eu     yellow lock  a cloud service inside the EU/EEA/CH: the data leaves the device, stays in Europe
 *   world  red flag     a cloud service outside the EU, or unknown: shown red on purpose
 *
 * Pure function describePrivacy() (testable); renderPrivacyBadges() only paints the result.
 * The LLM country comes from /health `llm_region` (ISO code, "LOCAL" or ""): the server knows its provider,
 * the browser does not. Cloud speech providers are fixed, known vendors.
 */

import { isDevHost } from "./availability.js";
import { isBrowserLlm } from "./tech-status.js";

// EU + EEA + Switzerland: "stays in Europe" for the neutral (non-red) flag.
const EUROPE = new Set(
  "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH".split(" "),
);
const COUNTRY_DE = { FR: "Frankreich", DE: "Deutschland", US: "USA", NL: "Niederlande", IE: "Irland", SE: "Schweden", GB: "Großbritannien" };
const COUNTRY_EN = { FR: "France", DE: "Germany", US: "USA", NL: "Netherlands", IE: "Ireland", SE: "Sweden", GB: "United Kingdom" };

/** ISO 3166 alpha-2 -> flag emoji ("FR" -> 🇫🇷); anything else -> globe. */
export function flagEmoji(code) {
  const c = String(code || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "🌐";
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

const LOCK = "lock"; // painted as an inline SVG in renderPrivacyBadges

function countryName(code, de) {
  const c = String(code || "").toUpperCase();
  return (de ? COUNTRY_DE : COUNTRY_EN)[c] || c;
}

function local(de, deText, enText) {
  return { level: "local", icon: LOCK, text: de ? deText : enText };
}
function cloud(code, de, deText, enText) {
  const c = String(code || "").toUpperCase();
  const level = EUROPE.has(c) ? "eu" : "world";
  const where = c ? countryName(c, de) : (de ? "Standort unbekannt" : "location unknown");
  return {
    level,
    icon: level === "eu" ? LOCK : flagEmoji(c), // inside Europe: a (yellow) lock, not a flag
    text: `${de ? deText : enText} — ${where}. ${
      de ? "Die Daten verlassen dein Gerät." : "The data leaves your device."
    }`,
  };
}

function describeLlm({ prefs, health, dev, de }) {
  if (isBrowserLlm(prefs.llm)) {
    return local(de, "KI läuft in deinem Browser — dein Text verlässt das Gerät nicht.", "The AI runs in your browser — your text never leaves the device.");
  }
  const provider = String(health?.llm_provider || "").toLowerCase();
  const region = String(health?.llm_region || "").toUpperCase();
  if (region === "LOCAL" && (provider !== "ollama" || dev)) {
    return local(de, "KI läuft auf deinem Rechner (Ollama) — dein Text verlässt ihn nicht.", "The AI runs on your machine (Ollama) — your text does not leave it.");
  }
  const name = provider === "scaleway" ? "Scaleway" : (de ? "Server-KI" : "Server AI");
  return cloud(region === "LOCAL" ? "" : region, de, `KI: ${name}`, `AI: ${name}`);
}

function describeTts({ prefs, de }) {
  if (prefs.tts === "elevenlabs") return cloud("US", de, "Stimme: ElevenLabs", "Voice: ElevenLabs");
  if (prefs.tts === "browser") {
    return local(de, "Stimme deines Geräts (Web Speech) — in der Regel offline, je nach Browser auch online.", "Your device's voice (Web Speech) — usually offline, online in some browsers.");
  }
  return local(de, "Stimme läuft in deinem Browser — dein Text verlässt das Gerät nicht.", "The voice runs in your browser — your text never leaves the device.");
}

function describeStt({ prefs, de }) {
  const stt = !prefs.stt || prefs.stt === "auto" ? "browser" : prefs.stt;
  if (stt === "whisper") {
    return local(de, "Spracherkennung (Whisper) läuft in deinem Browser — dein Audio verlässt das Gerät nicht.", "Speech recognition (Whisper) runs in your browser — your audio never leaves the device.");
  }
  if (stt === "elevenlabs") return cloud("US", de, "Spracherkennung: ElevenLabs", "Speech recognition: ElevenLabs");
  if (stt === "deepgram") return cloud("US", de, "Spracherkennung: Deepgram", "Speech recognition: Deepgram");
  // Web Speech API: the browser vendor's cloud (Chrome -> Google). Unknown country, so red globe.
  return {
    level: "world",
    icon: "🌐",
    text: de
      ? "Spracherkennung des Browsers (Web Speech): Chrome sendet das Audio an Google. Für lokale Erkennung „Whisper“ wählen."
      : "Browser speech recognition (Web Speech): Chrome sends the audio to Google. Pick “Whisper” for on-device recognition.",
  };
}

/**
 * @param {{prefs: object, health?: object|null, hostname?: string}} o
 * @returns {{key: string, label: string, level: "local"|"eu"|"world", icon: string, text: string}[]}
 */
export function describePrivacy({ prefs, health = null, hostname = "" }) {
  const de = String(prefs.lang || "de").startsWith("de");
  const dev = isDevHost(hostname);
  return [
    { key: "tts", label: "TTS", ...describeTts({ prefs, de }) },
    { key: "stt", label: "STT", ...describeStt({ prefs, de }) },
    { key: "llm", label: "LLM", ...describeLlm({ prefs, health, dev, de }) },
  ];
}

const LOCK_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';

/** Paint the chips into `container` (a <div id="privacyBadges">). Safe to call repeatedly. */
export function renderPrivacyBadges(container, items, { onClick } = {}) {
  if (!container) return;
  container.textContent = "";
  for (const item of items) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `privacy-chip privacy-chip--${item.level}`;
    b.dataset.service = item.key;
    b.title = `${item.label}: ${item.text}`;
    b.setAttribute("aria-label", `${item.label}: ${item.text}`);
    const icon = document.createElement("span");
    icon.className = "privacy-chip__icon";
    if (item.icon === LOCK) icon.innerHTML = LOCK_SVG;
    else icon.textContent = item.icon;
    const label = document.createElement("span");
    label.className = "privacy-chip__label";
    label.textContent = item.label;
    b.append(icon, label);
    if (onClick) b.addEventListener("click", onClick);
    container.append(b);
  }
}
