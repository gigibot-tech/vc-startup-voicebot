/**
 * Shared Web Worker hosting Transformers.js pipelines for Whisper STT + LLM + TTS.
 * Slots: whisper (ASR), llm (text-generation), tts (MMS DE/EN).
 *
 * Protocol (main ↔ worker):
 *   { id, type: "check"|"load"|"dispose"|"transcribe"|"generate"|"synthesize"|"cancel"|"ping", ... }
 *   progress / result / error replies include the same id when applicable.
 */
import {
  env,
  pipeline,
  TextStreamer,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm";

env.allowLocalModels = false;
env.useBrowserCache = true;

/** @typedef {"whisper"|"llm"|"tts"} SlotKey */

const LLM_MODELS = {
  "granite-3b": {
    task: "text-generation",
    modelId: "onnx-community/granite-4.0-micro-ONNX-web",
    dtype: "q4f16",
    label: "Granite 4 3B · WebGPU · q4f16",
  },
  "gemma-3n-e2b": {
    task: "text-generation",
    modelId: "onnx-community/gemma-3n-E2B-it-ONNX",
    dtype: {
      embed_tokens: "q4f16",
      audio_encoder: "q4",
      vision_encoder: "fp16",
      decoder_model_merged: "q4f16",
    },
    label: "Gemma 3n E2B · WebGPU · q4f16",
  },
};

const TTS_MODELS = {
  de: {
    task: "text-to-speech",
    modelId: "Xenova/mms-tts-deu",
    dtype: "q8",
    device: "wasm",
    label: "MMS TTS Deutsch · ~36MB",
  },
  en: {
    task: "text-to-speech",
    modelId: "Xenova/mms-tts-eng",
    dtype: "q8",
    device: "wasm",
    label: "MMS TTS English · ~36MB",
  },
};

const SLOTS = {
  whisper: {
    task: "automatic-speech-recognition",
    modelId: "onnx-community/whisper-tiny",
    dtype: "q8",
    device: "wasm",
    label: "Whisper Tiny · WASM · q8",
  },
  llm: { ...LLM_MODELS["granite-3b"] },
  tts: { ...TTS_MODELS.de },
};

/** @type {Record<string, any>} */
const pipes = { whisper: null, llm: null, tts: null };
/** @type {Record<string, string>} */
const states = { whisper: "unloaded", llm: "unloaded", tts: "unloaded" };
/** @type {AbortController|null} */
let loadAbort = null;
let genAbort = false;
/** Tracks whether Cache API already holds model shards (not in RAM). */
const knownCached = { whisper: false, llm: false, tts: false };

async function pickDevice() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return "webgpu";
    }
  } catch {
    /* fall through */
  }
  return "wasm";
}

function post(msg) {
  self.postMessage(msg);
}

function setState(slot, state, extra = {}) {
  states[slot] = state;
  post({ type: "state", slot, state, label: SLOTS[slot].label, ...extra });
}

function aggregateProgress(files) {
  let loaded = 0;
  let total = 0;
  let done = 0;
  const keys = Object.keys(files);
  for (const k of keys) {
    const f = files[k];
    loaded += f.loaded || 0;
    total += f.total || 0;
    if (f.status === "done" || (f.total && f.loaded >= f.total)) done += 1;
  }
  const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
  return { loaded, total, pct, shard: `${done}/${keys.length || 1}` };
}

/** Probe Cache API for huggingface model shards (ModelRegistry-style). */
async function isModelInBrowserCache(modelId) {
  if (typeof caches === "undefined") return false;
  try {
    const names = await caches.keys();
    const needle = modelId.toLowerCase();
    for (const name of names) {
      const cache = await caches.open(name);
      const reqs = await cache.keys();
      for (const req of reqs) {
        if (String(req.url || "").toLowerCase().includes(needle)) return true;
      }
    }
  } catch {
    /* cache probe optional */
  }
  return false;
}

async function setTtsModel(modelKey, { id } = {}) {
  const key = TTS_MODELS[modelKey] ? modelKey : "de";
  const nextCfg = TTS_MODELS[key];
  const changed = SLOTS.tts.modelId !== nextCfg.modelId;
  if (changed && pipes.tts) {
    try { await pipes.tts.dispose?.(); } catch { /* ignore */ }
    pipes.tts = null;
  }
  SLOTS.tts = { ...nextCfg };
  if (changed) {
    const cached = await isModelInBrowserCache(SLOTS.tts.modelId);
    knownCached.tts = cached;
    setState("tts", cached ? "cached_idle" : "unloaded");
  } else {
    setState("tts", states.tts);
  }
  post({ type: "checked", id, slot: "tts", state: states.tts, label: SLOTS.tts.label });
}

async function setLlmModel(modelKey, { id } = {}) {
  const key = LLM_MODELS[modelKey] ? modelKey : "granite-3b";
  const nextCfg = LLM_MODELS[key];
  const changed = SLOTS.llm.modelId !== nextCfg.modelId;
  if (changed && pipes.llm) {
    try { await pipes.llm.dispose?.(); } catch { /* ignore */ }
    pipes.llm = null;
  }
  SLOTS.llm = { ...nextCfg };
  if (changed) {
    const cached = await isModelInBrowserCache(SLOTS.llm.modelId);
    knownCached.llm = cached;
    setState("llm", cached ? "cached_idle" : "unloaded");
  } else {
    setState("llm", states.llm);
  }
  post({ type: "checked", id, slot: "llm", state: states.llm, label: SLOTS.llm.label });
}

async function checkSlot(slot, { id, modelKey } = {}) {
  if (slot === "llm" && modelKey && LLM_MODELS[modelKey]) {
    await setLlmModel(modelKey, { id });
    return;
  }
  if (slot === "tts" && modelKey && TTS_MODELS[modelKey]) {
    await setTtsModel(modelKey, { id });
    return;
  }
  if (!SLOTS[slot]) throw new Error(`Unknown slot: ${slot}`);
  if (pipes[slot] && (states[slot] === "ready" || states[slot] === "running")) {
    setState(slot, states[slot] === "running" ? "running" : "ready");
    post({ type: "checked", id, slot, state: states[slot], cached: true });
    return;
  }
  setState(slot, "checking_cache");
  const cached = knownCached[slot] || (await isModelInBrowserCache(SLOTS[slot].modelId));
  knownCached[slot] = cached;
  if (cached) {
    setState(slot, "cached_idle");
    post({ type: "checked", id, slot, state: "cached_idle", cached: true });
  } else {
    setState(slot, "unloaded");
    post({ type: "checked", id, slot, state: "unloaded", cached: false });
  }
}

async function loadSlot(slot, { id, modelKey } = {}) {
  if (slot === "llm" && modelKey && LLM_MODELS[modelKey]) {
    const nextCfg = LLM_MODELS[modelKey];
    if (SLOTS.llm.modelId !== nextCfg.modelId && pipes.llm) {
      try { await pipes.llm.dispose?.(); } catch { /* ignore */ }
      pipes.llm = null;
    }
    SLOTS.llm = { ...nextCfg };
  }
  if (slot === "tts" && modelKey && TTS_MODELS[modelKey]) {
    const nextCfg = TTS_MODELS[modelKey];
    if (SLOTS.tts.modelId !== nextCfg.modelId && pipes.tts) {
      try { await pipes.tts.dispose?.(); } catch { /* ignore */ }
      pipes.tts = null;
    }
    SLOTS.tts = { ...nextCfg };
  }
  if (!SLOTS[slot]) throw new Error(`Unknown slot: ${slot}`);
  if (pipes[slot] && states[slot] === "ready") {
    setState(slot, "ready");
    post({ type: "ready", id, slot, label: SLOTS[slot].label });
    return;
  }
  if (loadAbort) {
    try { loadAbort.abort(); } catch { /* ignore */ }
  }
  loadAbort = new AbortController();
  const signal = loadAbort.signal;
  const cfg = SLOTS[slot];
  setState(slot, "checking_cache");
  const device = cfg.device || (await pickDevice());
  const alreadyCached = knownCached[slot] || (await isModelInBrowserCache(cfg.modelId));
  knownCached[slot] = alreadyCached;

  const files = {};
  let lastTs = performance.now();
  let lastBytes = 0;
  let sawNetworkProgress = false;

  if (alreadyCached) {
    setState(slot, "warming_up", { device, progress: 100 });
  } else {
    setState(slot, "downloading", { device, progress: 0 });
  }

  const progress_callback = (ev) => {
    if (!ev || signal.aborted) return;
    if (ev.status === "initiate" || ev.status === "download" || ev.status === "progress") {
      sawNetworkProgress = true;
      const key = ev.file || ev.name || "model";
      files[key] = {
        loaded: ev.loaded || 0,
        total: ev.total || files[key]?.total || 0,
        status: ev.status,
      };
      const agg = aggregateProgress(files);
      const now = performance.now();
      const dt = Math.max(0.001, (now - lastTs) / 1000);
      const speed = (agg.loaded - lastBytes) / dt;
      lastTs = now;
      lastBytes = agg.loaded;
      setState(slot, "downloading", {
        device,
        progress: agg.pct,
        loaded: agg.loaded,
        total: agg.total,
        speed,
        shard: agg.shard,
      });
    }
    if (ev.status === "done" || ev.status === "ready") {
      if (!signal.aborted) setState(slot, "warming_up", { device, progress: 100 });
    }
  };

  try {
    if (!alreadyCached && !sawNetworkProgress) {
      setState(slot, "downloading", { device, progress: 0 });
    } else if (alreadyCached) {
      setState(slot, "warming_up", { device, progress: 100 });
    }
    const pipe = await pipeline(cfg.task, cfg.modelId, {
      dtype: cfg.dtype,
      device,
      progress_callback,
    });
    if (signal.aborted) {
      try { await pipe.dispose?.(); } catch { /* ignore */ }
      pipes[slot] = null;
      setState(slot, knownCached[slot] ? "cached_idle" : "unloaded");
      post({ type: "cancelled", id, slot });
      return;
    }
    pipes[slot] = pipe;
    knownCached[slot] = true;
    setState(slot, "ready", { device });
    post({ type: "ready", id, slot, label: cfg.label, device });
  } catch (err) {
    if (signal.aborted) {
      pipes[slot] = null;
      setState(slot, knownCached[slot] ? "cached_idle" : "unloaded");
      post({ type: "cancelled", id, slot });
      return;
    }
    pipes[slot] = null;
    const message = String(err?.message || err);
    setState(slot, "error", { error: message });
    post({ type: "error", id, slot, message });
  } finally {
    if (loadAbort?.signal === signal) loadAbort = null;
  }
}

async function disposeSlot(slot, { id } = {}) {
  const p = pipes[slot];
  pipes[slot] = null;
  if (p?.dispose) {
    try { await p.dispose(); } catch { /* ignore */ }
  }
  knownCached[slot] = true;
  setState(slot, "cached_idle");
  post({ type: "disposed", id, slot });
}

async function ensureReady(slot) {
  if (pipes[slot] && (states[slot] === "ready" || states[slot] === "running")) return;
  await loadSlot(slot);
  if (!pipes[slot]) throw new Error(`${slot} model not ready`);
}

function chatPrompt(system, user) {
  return (
    `<|im_start|>system\n${system}<|im_end|>\n` +
    `<|im_start|>user\n${user}<|im_end|>\n` +
    `<|im_start|>assistant\n`
  );
}

function extractGeneratedString(out) {
  const first = Array.isArray(out) ? out[0] : out;
  const gen = first?.generated_text ?? first;
  if (typeof gen === "string") return gen;
  if (Array.isArray(gen) && gen.length) {
    const last = gen[gen.length - 1];
    if (typeof last === "string") return last;
    if (last && typeof last.content === "string") return last.content;
  }
  if (gen && typeof gen.content === "string") return gen.content;
  return "";
}

async function generateText({ id, system, user, max_tokens = 256, stream = false }) {
  await ensureReady("llm");
  const pipe = pipes.llm;
  setState("llm", "running");
  genAbort = false;
  const messages = [
    { role: "system", content: String(system || "") },
    { role: "user", content: String(user || "") },
  ];
  // Browser 1.5B model: cap max_new_tokens so extract doesn't hang for minutes.
  const cap = stream ? 220 : 900;
  const max_new_tokens = Math.max(32, Math.min(cap, Number(max_tokens) || 200));

  try {
    let full = "";
    if (stream) {
      let streamer;
      try {
        streamer = new TextStreamer(pipe.tokenizer, {
          skip_prompt: true,
          skip_special_tokens: true,
          callback_function: (text) => {
            if (genAbort || !text) return;
            full += text;
            post({ type: "delta", id, text });
          },
        });
      } catch {
        streamer = undefined;
      }
      const out = await pipe(messages, {
        max_new_tokens,
        do_sample: false,
        return_full_text: false,
        ...(streamer ? { streamer } : {}),
      });
      if (!full) {
        full = extractGeneratedString(out);
        if (full) post({ type: "delta", id, text: full });
      }
    } else {
      const out = await pipe(messages, {
        max_new_tokens,
        do_sample: false,
        return_full_text: false,
      });
      full = extractGeneratedString(out);
    }
    setState("llm", "ready");
    post({ type: "generated", id, text: full.trim() });
  } catch (err) {
    try {
      const prompt = chatPrompt(system, user);
      const out = await pipe(prompt, {
        max_new_tokens,
        do_sample: false,
        return_full_text: false,
      });
      const full = extractGeneratedString(out).trim();
      setState("llm", "ready");
      if (stream && full) post({ type: "delta", id, text: full });
      post({ type: "generated", id, text: full });
    } catch (err2) {
      setState("llm", "error", { error: String(err2?.message || err2) });
      post({ type: "error", id, slot: "llm", message: String(err2?.message || err2 || err) });
    }
  }
}

function toFloat32(audio) {
  if (!audio) return new Float32Array(0);
  if (audio instanceof Float32Array) return audio;
  if (audio.data) return toFloat32(audio.data);
  return new Float32Array(audio);
}

async function synthesizeSpeech({ id, text, language }) {
  const lang = String(language || "de").slice(0, 2).toLowerCase() === "en" ? "en" : "de";
  if (SLOTS.tts.modelId !== TTS_MODELS[lang].modelId || !pipes.tts) {
    await loadSlot("tts", { modelKey: lang });
  }
  await ensureReady("tts");
  const pipe = pipes.tts;
  setState("tts", "running");
  try {
    const result = await pipe(String(text || ""));
    const samples = toFloat32(result?.audio);
    const rate = Number(result?.sampling_rate) || 16000;
    setState("tts", "ready");
    post({ type: "speech", id, audio: samples, sampling_rate: rate });
  } catch (err) {
    setState("tts", "error", { error: String(err?.message || err) });
    post({ type: "error", id, slot: "tts", message: String(err?.message || err) });
  }
}

async function transcribe({ id, audio, language }) {
  await ensureReady("whisper");
  const pipe = pipes.whisper;
  setState("whisper", "running");
  try {
    const lang = String(language || "de").slice(0, 2).toLowerCase();
    const result = await pipe(audio, {
      language: lang === "en" ? "english" : "german",
      task: "transcribe",
      return_timestamps: false,
      // Whisper reads ONE 30 s window; without chunking everything after ~30 s is silently cut
      // off (the end of a long answer disappears). Chunk with overlap and stitch the text back.
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (typeof result === "string" ? result : result?.text || "").trim();
    setState("whisper", "ready");
    post({ type: "transcript", id, text });
  } catch (err) {
    setState("whisper", "error", { error: String(err?.message || err) });
    post({ type: "error", id, slot: "whisper", message: String(err?.message || err) });
  }
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const { type, id, slot } = msg;
  try {
    if (type === "ping") {
      post({
        type: "pong",
        id,
        states: { ...states },
        labels: Object.fromEntries(
          Object.entries(SLOTS).map(([k, v]) => [k, v.label]),
        ),
      });
      return;
    }
    if (type === "check") {
      await checkSlot(slot, { id, modelKey: msg.modelKey });
      return;
    }
    if (type === "load") {
      await loadSlot(slot, { id, modelKey: msg.modelKey });
      return;
    }
    if (type === "dispose") {
      await disposeSlot(slot, { id });
      return;
    }
    if (type === "cancel") {
      genAbort = true;
      if (loadAbort) {
        try { loadAbort.abort(); } catch { /* ignore */ }
      }
      if (slot && (states[slot] === "downloading" || states[slot] === "warming_up" || states[slot] === "checking_cache")) {
        setState(slot, knownCached[slot] ? "cached_idle" : "unloaded");
      }
      post({ type: "cancelled", id, slot });
      return;
    }
    if (type === "transcribe") {
      await transcribe({ id, audio: msg.audio, language: msg.language });
      return;
    }
    if (type === "generate") {
      await generateText({
        id,
        system: msg.system,
        user: msg.user,
        max_tokens: msg.max_tokens,
        stream: Boolean(msg.stream),
      });
      return;
    }
    if (type === "synthesize") {
      await synthesizeSpeech({
        id,
        text: msg.text,
        language: msg.language,
      });
      return;
    }
  } catch (err) {
    post({ type: "error", id, slot, message: String(err?.message || err) });
  }
};
