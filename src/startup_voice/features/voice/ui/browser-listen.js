/**
 * Browser-side "ears" for the LiveKit call when speech-to-text runs in the browser (local Whisper).
 *
 * The worker only speaks in that mode; the mic never leaves the browser. This file finds where an
 * utterance starts and ends (energy VAD) and hands the audio to Whisper.
 *
 *   createEndpointer()   pure state machine over audio frames (unit-tested with node)
 *   resampleTo16k()      Whisper wants 16 kHz mono floats
 *   createMicListener()  getUserMedia + AudioWorklet glue (browser only)
 *
 * Energy VAD is simpler than the server's (Silero): fine for a quiet room, weaker in noise. The
 * noise floor adapts, and the threshold is raised while the agent speaks so its own voice leaking
 * into the mic does not cut it off.
 */

export const WHISPER_RATE = 16000;

const DEFAULTS = {
  minRms: 0.012,        // never trigger below this level
  noiseFactor: 3.5,     // speech must be this many times louder than the room
  startMs: 120,         // loud for this long = speech started
  endSilenceMs: 900,    // quiet for this long = the founder finished (they pause to think)
  minSpeechMs: 250,     // shorter than this = a cough/click, dropped
  preRollMs: 300,       // audio kept from just before the start so first syllables survive
  maxUtteranceMs: 30000,
};

const rmsOf = (frame) => {
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) sum += frame[i] * frame[i];
  return Math.sqrt(sum / (frame.length || 1));
};

const concat = (chunks) => {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

/**
 * Feed frames with push(frame, sampleRate); it returns events:
 *   {type:"speechstart"}  |  {type:"utterance", samples, sampleRate}  |  {type:"discard"}
 * @param {Partial<typeof DEFAULTS> & {getSensitivity?: () => number}} [opts]
 *   getSensitivity(): multiplies the threshold (>1 = harder to trigger, used while the agent talks)
 */
export function createEndpointer(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const sens = () => Math.max(0.5, Number(cfg.getSensitivity?.() ?? 1) || 1);
  let noise = 0.004;
  let speaking = false;
  let loudMs = 0;
  let quietMs = 0;
  let speechMs = 0;
  let preroll = []; // [{frame, ms}]
  let prerollMs = 0;
  let chunks = [];
  let totalMs = 0;

  function reset() {
    speaking = false; loudMs = 0; quietMs = 0; speechMs = 0; chunks = []; totalMs = 0;
  }

  function finish(sampleRate) {
    const events = [];
    if (speechMs >= cfg.minSpeechMs) events.push({ type: "utterance", samples: concat(chunks), sampleRate });
    else events.push({ type: "discard" });
    reset();
    return events;
  }

  function push(frame, sampleRate) {
    const ms = (frame.length / sampleRate) * 1000;
    const level = rmsOf(frame);
    const threshold = Math.max(cfg.minRms, noise * cfg.noiseFactor) * sens();
    const events = [];

    if (!speaking) {
      if (level <= threshold) noise = Math.max(0.001, noise * 0.95 + level * 0.05); // learn the room
      preroll.push({ frame, ms });
      prerollMs += ms;
      while (prerollMs > cfg.preRollMs && preroll.length > 1) prerollMs -= preroll.shift().ms;

      loudMs = level > threshold ? loudMs + ms : 0;
      if (loudMs >= cfg.startMs * Math.min(sens(), 2)) {
        speaking = true;
        chunks = preroll.map((p) => p.frame);
        totalMs = prerollMs;
        speechMs = loudMs;
        quietMs = 0;
        preroll = []; prerollMs = 0; loudMs = 0;
        events.push({ type: "speechstart" });
      }
      return events;
    }

    chunks.push(frame);
    totalMs += ms;
    if (level > threshold * 0.6) { // hysteresis: stay "speaking" through quieter syllables
      quietMs = 0;
      speechMs += ms;
    } else {
      quietMs += ms;
    }
    if (quietMs >= cfg.endSilenceMs || totalMs >= cfg.maxUtteranceMs) return finish(sampleRate);
    return events;
  }

  return { push, reset, isSpeaking: () => speaking, noiseFloor: () => noise };
}

/** Linear-interpolation resample to 16 kHz (Whisper's input rate). */
export function resampleTo16k(samples, fromRate) {
  if (fromRate === WHISPER_RATE) return samples;
  const ratio = fromRate / WHISPER_RATE;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + (samples[Math.min(i0 + 1, samples.length - 1)] ?? 0) * frac;
  }
  return out;
}

const WORKLET_SRC = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = []; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      this.buf.push(new Float32Array(ch)); this.n += ch.length;
      if (this.n >= 1024) {
        const out = new Float32Array(this.n); let at = 0;
        for (const b of this.buf) { out.set(b, at); at += b.length; }
        this.port.postMessage(out, [out.buffer]); this.buf = []; this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("sv-tap", Tap);
`;

/**
 * Open the microphone and report utterances. Browser only.
 * @param {{onSpeechStart: () => void, onUtterance: (samples: Float32Array, rate: number) => void,
 *          getSensitivity?: () => number}} h
 */
export function createMicListener({ onSpeechStart, onUtterance, getSensitivity }) {
  let stream = null;
  let ctx = null;
  let node = null;

  return {
    async start() {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      const endpointer = createEndpointer({ getSensitivity });
      node = new AudioWorkletNode(ctx, "sv-tap");
      node.port.onmessage = (e) => {
        for (const ev of endpointer.push(e.data, ctx.sampleRate)) {
          if (ev.type === "speechstart") onSpeechStart();
          else if (ev.type === "utterance") onUtterance(ev.samples, ev.sampleRate);
        }
      };
      ctx.createMediaStreamSource(stream).connect(node); // not connected to the speakers
    },
    stop() {
      try { node?.disconnect(); } catch { /* gone */ }
      stream?.getTracks().forEach((t) => t.stop());
      try { ctx?.close(); } catch { /* gone */ }
      stream = ctx = node = null;
    },
  };
}
