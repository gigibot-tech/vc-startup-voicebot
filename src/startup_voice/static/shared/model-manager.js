/**
 * Shared Transformers.js model hub + reusable ModelStatusCard UI.
 *
 * Slots: "whisper" (ASR), "llm" (text-generation), "tts" (MMS DE/EN) — one Web Worker.
 * State machine: unloaded → checking_cache → downloading → warming_up → ready → running → error
 *                cached_idle ↔ ready (Unload RAM / Load into GPU)
 */

const LLM_LABELS = {
  "granite-3b": "Granite 4 3B · WebGPU · q4f16",
  "gemma-3n-e2b": "Gemma 3n E2B · WebGPU · q4f16",
};

const TTS_LABELS = {
  de: "MMS TTS Deutsch · WebGPU",
  en: "MMS TTS English · WebGPU",
};

const SLOT_META = {
  whisper: { badge: "Whisper Small · WASM · q8", task: "STT" },
  llm: { badge: LLM_LABELS["granite-3b"], task: "LLM" },
  tts: { badge: TTS_LABELS.de, task: "TTS" },
};

const STATE_LABEL = {
  unloaded: "Not downloaded",
  checking_cache: "Checking cache…",
  cached_idle: "Cached",
  downloading: "Downloading",
  warming_up: "Warming up shaders…",
  ready: "Ready",
  running: "Running…",
  error: "Error",
};

const isEn = () => String(document.documentElement?.lang || "de").startsWith("en");
const DE_STATE = {
  unloaded: "Nicht geladen", checking_cache: "Prüfe Speicher …", cached_idle: "Gespeichert",
  downloading: "Lädt", warming_up: "Wird vorbereitet …", ready: "Bereit", running: "Arbeitet …", error: "Fehler",
};
const DE_ACT = { download: "Modell laden", cancel: "Abbrechen", load: "In GPU laden", unload: "Aus Speicher entfernen", retry: "Erneut versuchen" };
const EN_ACT = { download: "Download model", cancel: "Cancel", load: "Load into GPU", unload: "Unload RAM", retry: "Retry" };

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  return `${(v / 1024 ** 3).toFixed(2)} GB`;
}

function fmtSpeed(bps) {
  if (!bps || bps < 0) return "";
  return `${fmtBytes(bps)}/s`;
}

function uid() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function createModelManager() {
  /** @type {Worker|null} */
  let worker = null;
  /** @type {Map<string, {resolve: Function, reject: Function, onDelta?: Function}>} */
  const pending = new Map();
  /** @type {Record<string, {state: string, progress: number, loaded: number, total: number, speed: number, shard: string, error: string, label: string, device: string}>} */
  const slotState = {
    whisper: { state: "unloaded", progress: 0, loaded: 0, total: 0, speed: 0, shard: "", error: "", label: SLOT_META.whisper.badge, device: "" },
    llm: { state: "unloaded", progress: 0, loaded: 0, total: 0, speed: 0, shard: "", error: "", label: SLOT_META.llm.badge, device: "" },
    tts: { state: "unloaded", progress: 0, loaded: 0, total: 0, speed: 0, shard: "", error: "", label: SLOT_META.tts.badge, device: "" },
  };
  /** @type {Set<(slot: string, info: object) => void>} */
  const listeners = new Set();
  /** @type {((info: {slot: string, message: string, progress: number}) => void)|null} */
  let onProcessBanner = null;

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker("/static/shared/transformers-worker.js", { type: "module" });
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === "state" && msg.slot) {
        const cur = slotState[msg.slot] || (slotState[msg.slot] = {});
        Object.assign(cur, {
          state: msg.state,
          progress: msg.progress ?? cur.progress ?? 0,
          loaded: msg.loaded ?? cur.loaded ?? 0,
          total: msg.total ?? cur.total ?? 0,
          speed: msg.speed ?? cur.speed ?? 0,
          shard: msg.shard ?? cur.shard ?? "",
          error: msg.error ?? "",
          label: msg.label || cur.label || SLOT_META[msg.slot]?.badge || msg.slot,
          device: msg.device || cur.device || "",
        });
        notify(msg.slot);
        if (msg.state === "downloading" || msg.state === "warming_up" || msg.state === "checking_cache") {
          onProcessBanner?.({
            slot: msg.slot,
            state: msg.state,
            message: msg.state === "warming_up"
              ? `${cur.label}: warming up…`
              : msg.state === "checking_cache"
                ? `${cur.label}: checking cache…`
                : `${cur.label}: ${cur.progress}%`,
            progress: cur.progress || 0,
            active: true,
          });
        } else if (msg.state === "ready" || msg.state === "cached_idle" || msg.state === "unloaded" || msg.state === "error") {
          onProcessBanner?.({ slot: msg.slot, message: "", progress: 0, active: false });
        }
        return;
      }
      if (msg.type === "checked" || msg.type === "ready" || msg.type === "disposed" || msg.type === "cancelled") {
        if (msg.slot) {
          if (msg.state) slotState[msg.slot].state = msg.state;
          notify(msg.slot);
        }
        const p = msg.id && pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve(msg);
        }
        if (msg.type === "ready" || msg.type === "cancelled" || msg.type === "disposed") {
          onProcessBanner?.({ slot: msg.slot, message: "", progress: 0, active: false });
        }
        return;
      }
      if (msg.type === "delta") {
        const p = msg.id && pending.get(msg.id);
        p?.onDelta?.(msg.text || "");
        return;
      }
      if (msg.type === "generated" || msg.type === "transcript" || msg.type === "speech") {
        const p = msg.id && pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.resolve(msg);
        }
        if (msg.type === "generated") notify("llm");
        if (msg.type === "transcript") notify("whisper");
        if (msg.type === "speech") notify("tts");
        return;
      }
      if (msg.type === "error") {
        if (msg.slot) {
          slotState[msg.slot].state = "error";
          slotState[msg.slot].error = msg.message || "error";
          notify(msg.slot);
        }
        const p = msg.id && pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p.reject(new Error(msg.message || "Worker error"));
        }
      }
    };
    worker.onerror = (err) => {
      console.error("[transformers-worker]", err);
    };
    return worker;
  }

  function notify(slot) {
    const info = { ...slotState[slot] };
    listeners.forEach((fn) => {
      try { fn(slot, info); } catch { /* ignore */ }
    });
  }

  function call(payload, { onDelta } = {}) {
    ensureWorker();
    const id = payload.id || uid();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onDelta });
      worker.postMessage({ ...payload, id });
    });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function getState(slot) {
    return { ...slotState[slot] };
  }

  function setProcessBannerHook(fn) {
    onProcessBanner = fn;
  }

  let activeLlmKey = "granite-3b";
  let activeTtsKey = "de";

  async function setLlmModelKey(modelKey) {
    const key = LLM_LABELS[modelKey] ? modelKey : "granite-3b";
    activeLlmKey = key;
    SLOT_META.llm.badge = LLM_LABELS[key];
    slotState.llm.label = LLM_LABELS[key];
    notify("llm");
    return call({ type: "check", slot: "llm", modelKey: key });
  }

  async function setTtsLanguage(lang) {
    const key = String(lang || "de").toLowerCase().startsWith("en") ? "en" : "de";
    activeTtsKey = key;
    SLOT_META.tts.badge = TTS_LABELS[key];
    slotState.tts.label = TTS_LABELS[key];
    notify("tts");
    return call({ type: "check", slot: "tts", modelKey: key });
  }

  async function check(slot) {
    return call({
      type: "check",
      slot,
      ...(slot === "llm" ? { modelKey: activeLlmKey } : {}),
      ...(slot === "tts" ? { modelKey: activeTtsKey } : {}),
    });
  }

  async function load(slot) {
    return call({
      type: "load",
      slot,
      ...(slot === "llm" ? { modelKey: activeLlmKey } : {}),
      ...(slot === "tts" ? { modelKey: activeTtsKey } : {}),
    });
  }

  async function dispose(slot) {
    return call({ type: "dispose", slot });
  }

  async function cancel(slot) {
    return call({ type: "cancel", slot });
  }

  async function ensureLoaded(slot) {
    const st = slotState[slot]?.state;
    if (st === "ready" || st === "running") return;
    await load(slot);
  }

  /**
   * @param {Float32Array|ArrayBuffer} audioData 16 kHz mono float32
   * @param {string} language
   */
  async function transcribe(audioData, language = "de") {
    await ensureLoaded("whisper");
    const msg = await call({
      type: "transcribe",
      audio: audioData,
      language,
    });
    return String(msg.text || "").trim();
  }

  /**
   * Run reply (streamed) then extract (JSON) on the same loaded generator.
   * @param {{reply_system:string, reply_user:string, extract_system:string, extract_user:string, reply_max_tokens?:number, extract_max_tokens?:number}} prompts
   * @param {{onReplyDelta?: (t:string)=>void, onReplyDone?: (rawReply:string)=>void|Promise<void>, onPhase?: (phase:string)=>void}} hooks
   */
  async function runTurn(prompts, hooks = {}) {
    await ensureLoaded("llm");
    hooks.onPhase?.("reply");
    let streamed = "";
    const replyMsg = await call(
      {
        type: "generate",
        system: prompts.reply_system,
        user: prompts.reply_user,
        max_tokens: Math.min(220, prompts.reply_max_tokens || 220),
        stream: true,
      },
      {
        onDelta: (t) => {
          streamed += t;
          hooks.onReplyDelta?.(t);
        },
      },
    );
    const raw_reply = String(replyMsg.text || streamed || "").trim();
    if (hooks.onReplyDone) {
      await hooks.onReplyDone(raw_reply);
    }
    hooks.onPhase?.("extract");
    const extractMsg = await call({
      type: "generate",
      system: prompts.extract_system,
      user: prompts.extract_user,
      max_tokens: Math.min(600, prompts.extract_max_tokens || 600),
      stream: false,
    });
    const raw_extract = String(extractMsg.text || "").trim();
    return { raw_reply, raw_extract };
  }

  async function generateOnce(system, user, max_tokens = 400, { onDelta, stream = true } = {}) {
    await ensureLoaded("llm");
    let streamed = "";
    const msg = await call(
      { type: "generate", system, user, max_tokens, stream },
      {
        onDelta: (t) => {
          streamed += t;
          onDelta?.(t);
        },
      },
    );
    return String(msg.text || streamed || "").trim();
  }

  /**
   * @param {string} text
   * @param {string} [language]
   * @returns {Promise<{audio: Float32Array, sampling_rate: number}>}
   */
  // One sentence at a time into the worker (prefetching queues several; they must not overlap).
  let ttsChain = Promise.resolve();

  async function synthesize(text, language = "de") {
    const run = ttsChain.then(() => synthesizeNow(text, language));
    ttsChain = run.catch(() => {});
    return run;
  }

  async function synthesizeNow(text, language) {
    await setTtsLanguage(language);
    await ensureLoaded("tts");
    const msg = await call({
      type: "synthesize",
      text: String(text || ""),
      language,
    });
    const audio = msg.audio instanceof Float32Array
      ? msg.audio
      : new Float32Array(msg.audio || []);
    return { audio, sampling_rate: Number(msg.sampling_rate) || 16000 };
  }

  /**
   * Mount a reusable model status card into ``mountEl``.
   * @param {HTMLElement} mountEl
   * @param {"whisper"|"llm"|"tts"} slotKey
   */
  function createModelCard(mountEl, slotKey) {
    if (!mountEl || !SLOT_META[slotKey]) return { destroy() {} };
    const root = document.createElement("div");
    root.className = "model-card";
    root.dataset.slot = slotKey;
    root.innerHTML = `
      <div class="model-card__head">
        <span class="model-card__badge">${SLOT_META[slotKey].badge}</span>
        <span class="model-card__pill" data-pill>Not downloaded</span>
      </div>
      <div class="model-card__progress" hidden>
        <div class="model-card__bar"><i data-bar style="width:0%"></i></div>
        <div class="model-card__meta" data-meta></div>
      </div>
      <div class="model-card__actions">
        <button type="button" class="pill" data-act="download">Download model</button>
        <button type="button" class="pill-outline" data-act="cancel" hidden>Cancel</button>
        <button type="button" class="pill" data-act="load" hidden>Load into GPU</button>
        <button type="button" class="pill-outline" data-act="unload" hidden>Unload RAM</button>
        <button type="button" class="pill" data-act="retry" hidden>Retry</button>
      </div>`;
    mountEl.appendChild(root);

    const badgeEl = root.querySelector(".model-card__badge");
    const pill = root.querySelector("[data-pill]");
    const progress = root.querySelector(".model-card__progress");
    const bar = root.querySelector("[data-bar]");
    const meta = root.querySelector("[data-meta]");
    const btns = {
      download: root.querySelector('[data-act="download"]'),
      cancel: root.querySelector('[data-act="cancel"]'),
      load: root.querySelector('[data-act="load"]'),
      unload: root.querySelector('[data-act="unload"]'),
      retry: root.querySelector('[data-act="retry"]'),
    };

    function paint(info) {
      if (badgeEl && (info?.label || SLOT_META[slotKey]?.badge)) {
        badgeEl.textContent = info?.label || SLOT_META[slotKey].badge;
      }
      const st = info?.state || "unloaded";
      let label = (isEn() ? STATE_LABEL : DE_STATE)[st] || st;
      if (st === "downloading") label = `${isEn() ? "Downloading" : "Lädt"} ${info.progress || 0}%`;
      const act = isEn() ? EN_ACT : DE_ACT;
      for (const [k, el] of Object.entries(btns)) el.textContent = act[k];
      pill.textContent = label;
      pill.dataset.state = st;
      const showProg = st === "downloading" || st === "warming_up";
      progress.hidden = !showProg;
      if (showProg) {
        bar.style.width = `${Math.max(0, Math.min(100, info.progress || 0))}%`;
        const parts = [];
        if (info.total) parts.push(`${fmtBytes(info.loaded)} / ${fmtBytes(info.total)}`);
        if (info.speed) parts.push(fmtSpeed(info.speed));
        if (info.shard) parts.push(`shard ${info.shard}`);
        meta.textContent = parts.join(" · ");
      }
      btns.download.hidden = !(st === "unloaded");
      btns.cancel.hidden = !(st === "downloading" || st === "warming_up" || st === "checking_cache");
      btns.load.hidden = !(st === "cached_idle");
      btns.unload.hidden = !(st === "ready");
      btns.retry.hidden = !(st === "error");
      if (st === "error" && info.error) {
        meta.textContent = info.error;
        progress.hidden = false;
        bar.style.width = "0%";
      }
    }

    const unsub = subscribe((slot, info) => {
      if (slot === slotKey) paint(info);
    });
    paint(getState(slotKey));
    void check(slotKey).catch(() => { /* probe optional */ });

    btns.download.addEventListener("click", () => { void load(slotKey); });
    btns.cancel.addEventListener("click", () => { void cancel(slotKey); });
    btns.load.addEventListener("click", () => { void load(slotKey); });
    btns.unload.addEventListener("click", () => { void dispose(slotKey); });
    btns.retry.addEventListener("click", () => { void load(slotKey); });

    return {
      destroy() {
        unsub();
        root.remove();
      },
      paint: () => paint(getState(slotKey)),
    };
  }

  /**
   * Decode a recorded Blob to 16 kHz Float32Array for Whisper.
   * @param {Blob} blob
   */
  async function decodeAudioBlob(blob) {
    const buf = await blob.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    try {
      const decoded = await ctx.decodeAudioData(buf.slice(0));
      const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const src = offline.createBufferSource();
      // Mixdown to mono if needed
      let mono = decoded;
      if (decoded.numberOfChannels > 1) {
        const ch0 = decoded.getChannelData(0);
        const mixed = new Float32Array(ch0.length);
        for (let c = 0; c < decoded.numberOfChannels; c++) {
          const ch = decoded.getChannelData(c);
          for (let i = 0; i < mixed.length; i++) mixed[i] += ch[i] / decoded.numberOfChannels;
        }
        mono = ctx.createBuffer(1, mixed.length, decoded.sampleRate);
        mono.copyToChannel(mixed, 0);
      }
      src.buffer = mono;
      src.connect(offline.destination);
      src.start(0);
      const rendered = await offline.startRendering();
      return new Float32Array(rendered.getChannelData(0));
    } finally {
      try { await ctx.close(); } catch { /* ignore */ }
    }
  }

  return {
    subscribe,
    getState,
    setLlmModelKey,
    check,
    load,
    dispose,
    cancel,
    ensureLoaded,
    transcribe,
    synthesize,
    setTtsLanguage,
    runTurn,
    generateOnce,
    createModelCard,
    decodeAudioBlob,
    setProcessBannerHook,
  };
}

/** Singleton for the app shell. */
export const modelManager = createModelManager();
export { createModelManager, SLOT_META, STATE_LABEL };
