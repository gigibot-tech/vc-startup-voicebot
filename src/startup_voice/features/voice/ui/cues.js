/**
 * Tiny audio cues for a hands-free call, synthesised with Web Audio (no sound files).
 * They tell the founder, without looking at the screen:
 *   listen  two rising notes   "your turn, I'm listening"
 *   heard   one short tick     "got it, sending your answer"
 *   end     two falling notes  "call ended"
 * Quiet and short on purpose; the mic keeps echo-cancelling, and the driver also makes the
 * speech detector less sensitive for a moment after each cue (play() returns how long it lasts).
 */

/** [frequency Hz, start s, duration s] per note. Exported for tests. */
export const CUES = {
  listen: [[784, 0, 0.09], [1175, 0.09, 0.13]],
  heard: [[880, 0, 0.07]],
  end: [[784, 0, 0.09], [523, 0.09, 0.16]],
};

export const cueDurationMs = (name) => {
  const notes = CUES[name];
  return notes ? Math.round(Math.max(...notes.map(([, at, len]) => at + len)) * 1000) : 0;
};

/** @param {{isEnabled?: () => boolean, AudioContextCtor?: any, volume?: number}} [opts] */
export function createCues({ isEnabled = () => true, AudioContextCtor, volume = 0.07 } = {}) {
  let ctx = null;

  function context() {
    const Ctor = AudioContextCtor || globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    if (!ctx || ctx.state === "closed") ctx = new Ctor();
    if (ctx.state === "suspended") ctx.resume?.().catch?.(() => {});
    return ctx;
  }

  /** Plays the cue; returns its length in ms (0 if disabled/unknown/unsupported). */
  function play(name) {
    if (!isEnabled() || !CUES[name]) return 0;
    try {
      const c = context();
      if (!c) return 0;
      const t0 = c.currentTime + 0.01;
      for (const [freq, at, len] of CUES[name]) {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        // soft attack + decay so it never clicks
        gain.gain.setValueAtTime(0.0001, t0 + at);
        gain.gain.exponentialRampToValueAtTime(volume, t0 + at + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
        osc.connect(gain).connect(c.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + len + 0.02);
      }
      return cueDurationMs(name);
    } catch {
      return 0;
    }
  }

  return { play, close: () => { try { ctx?.close(); } catch { /* gone */ } ctx = null; } };
}
