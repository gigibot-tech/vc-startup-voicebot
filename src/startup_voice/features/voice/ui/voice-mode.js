/**
 * Voice mode switch: ONE `voice` object for the whole app, backed by interchangeable drivers.
 *
 *   classic   voice.js          push-to-talk: Web Speech / Whisper / cloud STT + TTS (always there)
 *   livekit   voice-livekit.js  hands-free WebRTC call with a server-side voice worker
 *
 * Every driver exposes the same methods (METHODS below). chat.js, sessions, proposals and
 * settings only ever see the switch, so adding a third mode = write a driver, register it in
 * app.js, add a transport on the server (features/voice/transports/). Nothing else changes.
 *
 * A mode is only selectable when the server says it is configured (/health -> voice_modes);
 * anything else silently resolves to "classic", so a stale preference never breaks the mic.
 */

/** The contract every driver implements (voice.js defines it; drivers may pass most through). */
export const METHODS = [
  "getPhase", "setStatus", "setVoicePhase", "setExtractBusy", "syncMicLabels",
  "sttLabel", "resolveSttProvider", "applySttProvider", "setProviders", "useBrowser",
  "stopMicCapture", "stopSpeak", "speak", "beginSpeakStream", "pushSpeakStream",
  "endSpeakStream", "onMicClick",
];

export const DEFAULT_MODE = "classic";

/**
 * @param {{drivers: Record<string, object>, getPreferred: () => string, getServerDefault?: () => string}} deps
 *   getPreferred(): the user's saved choice ("" = follow the server default).
 */
export function createVoiceSwitch({ drivers, getPreferred, getServerDefault = () => DEFAULT_MODE }) {
  for (const [name, driver] of Object.entries(drivers)) {
    const missing = METHODS.filter((m) => typeof driver[m] !== "function");
    if (missing.length) throw new Error(`voice driver "${name}" lacks: ${missing.join(", ")}`);
  }

  let available = new Set([DEFAULT_MODE]);
  let current = DEFAULT_MODE;

  const resolve = () => {
    const want = getPreferred() || getServerDefault() || DEFAULT_MODE;
    return available.has(want) && drivers[want] ? want : DEFAULT_MODE;
  };

  /** Re-resolve the mode and hand over between drivers (ends a running call first). */
  function refresh() {
    const next = resolve();
    if (next === current) return current;
    drivers[current].deactivate?.();
    current = next;
    drivers[current].activate?.();
    return current;
  }

  const api = {};
  for (const name of METHODS) api[name] = (...args) => drivers[current][name](...args);

  return Object.assign(api, {
    /** Modes the server reported as usable (e.g. from /health). "classic" is always included. */
    setAvailableModes(list) {
      available = new Set([DEFAULT_MODE, ...(Array.isArray(list) ? list : [])]);
      return refresh();
    },
    /** Call after the user changed the preference. */
    refresh,
    getMode: () => current,
    isAvailable: (mode) => available.has(mode),
    /** App state changed (session switched, language changed): let the active driver react. */
    onSessionChange: () => drivers[current].onSessionChange?.(),
  });
}
