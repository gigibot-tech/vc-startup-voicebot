/**
 * Browser "ears" for a LiveKit call when Settings > speech recognition = Web Speech (the browser's
 * own recognizer). No model download, no server: the worker only speaks.
 *
 * Chrome ends a recognition session after pauses even with `continuous`, so it is restarted on
 * `onend` for as long as the call is open. Results are dropped while `isPaused()` is true (the
 * agent is speaking - otherwise it would hear itself).
 *
 * End of turn: all words since the last turn are collected and sent ONE `quietMs` after the last
 * result (silence-end.js) - not whenever Chrome happens to call a phrase final, which splits one answer
 * into several turns and arrives late. After sending, the session is aborted so Chrome's own late
 * "final" for the same words cannot send them a second time.
 */

import { createSilenceEnd, WEB_SPEECH_QUIET_MS } from "./silence-end.js";

export function isWebSpeechSupported(win = globalThis) {
  return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition);
}

/**
 * @param {{lang: string, onFinal: (text: string) => void, onInterim?: (text: string) => void,
 *          onError?: (code: string) => void, isPaused?: () => boolean, Ctor?: Function,
 *          quietMs?: number, timers?: {setTimer: Function, clearTimer: Function}}} o
 */
export function createWebSpeechListener({
  lang, onFinal, onInterim, onError, isPaused, Ctor, quietMs = WEB_SPEECH_QUIET_MS, timers = {},
}) {
  const Recognition = Ctor || globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let rec = null;
  let wanted = false;
  let finals = "";   // phrases Chrome has finished since the last turn
  let interim = "";  // the phrase in progress

  const paused = () => Boolean(isPaused?.());
  const heard = () => `${finals} ${interim}`.replace(/\s+/g, " ").trim();

  const endTimer = createSilenceEnd({
    quietMs,
    ...timers,
    onQuiet: () => {
      const text = heard();
      finals = ""; interim = "";
      if (!text) return;
      try { rec?.abort(); } catch { /* already stopped */ } // drops Chrome's own late "final" of the same words
      onFinal(text);
    },
  });

  function open() {
    rec = new Recognition();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      if (paused()) { finals = ""; interim = ""; endTimer.cancel(); return; }
      interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        const text = String(r[0]?.transcript || "").trim();
        if (!text) continue;
        if (r.isFinal) finals = `${finals} ${text}`.trim();
        else interim = `${interim} ${text}`.trim();
      }
      const now = heard();
      if (!now) return;
      onInterim?.(now);
      endTimer.touch();
    };
    rec.onerror = (ev) => {
      const code = String(ev?.error || "error");
      if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
        wanted = false; // fatal: restarting would loop
        endTimer.cancel();
        onError?.(code);
      }
      // "no-speech" / "aborted" / "network": onend follows and restarts
    };
    rec.onend = () => {
      if (!wanted) return;
      try { open(); rec.start(); } catch { onError?.("restart-failed"); }
    };
  }

  return {
    async start() {
      if (!Recognition) throw new Error("Web Speech is not available in this browser");
      wanted = true;
      open();
      rec.start();
    },
    stop() {
      wanted = false;
      endTimer.cancel();
      finals = ""; interim = "";
      try { rec?.stop(); } catch { /* already stopped */ }
      rec = null;
    },
    getStream: () => null, // the recognizer owns the mic; a second capture would steal it on macOS
  };
}
