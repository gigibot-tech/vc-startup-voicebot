/**
 * Browser "ears" for a LiveKit call when Settings > speech recognition = Web Speech (the browser's
 * own recognizer). No model download, no server: the worker only speaks.
 *
 * Chrome ends a recognition session after pauses even with `continuous`, so it is restarted on
 * `onend` for as long as the call is open. Results are dropped while `isPaused()` is true (the
 * agent is speaking - otherwise it would hear itself).
 */

export function isWebSpeechSupported(win = globalThis) {
  return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition);
}

/**
 * @param {{lang: string, onFinal: (text: string) => void, onInterim?: (text: string) => void,
 *          onError?: (code: string) => void, isPaused?: () => boolean, Ctor?: Function}} o
 */
export function createWebSpeechListener({ lang, onFinal, onInterim, onError, isPaused, Ctor }) {
  const Recognition = Ctor || globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  let rec = null;
  let wanted = false;

  const paused = () => Boolean(isPaused?.());

  function open() {
    rec = new Recognition();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = (ev) => {
      if (paused()) return;
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        const text = String(r[0]?.transcript || "").trim();
        if (!text) continue;
        if (r.isFinal) onFinal(text);
        else interim += `${text} `;
      }
      if (interim.trim()) onInterim?.(interim.trim());
    };
    rec.onerror = (ev) => {
      const code = String(ev?.error || "error");
      if (code === "not-allowed" || code === "service-not-allowed" || code === "audio-capture") {
        wanted = false; // fatal: restarting would loop
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
      try { rec?.stop(); } catch { /* already stopped */ }
      rec = null;
    },
    getStream: () => null, // the recognizer owns the mic; a second capture would steal it on macOS
  };
}
