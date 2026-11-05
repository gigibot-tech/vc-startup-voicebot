/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║  voice.js — VOICE I/O ONLY.  THIS FILE NEVER CALLS THE LLM.                  ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT THIS FILE DOES
 * -------------------
 *   • Mic  → text : records speech and turns it into a string (STT).
 *   • text → Mic  : plays the agent's reply out loud (TTS).
 *   • Owns the mic state machine: idle → listening → thinking → speaking → idle.
 *
 * WHAT THIS FILE DOES *NOT* DO
 * ----------------------------
 *   ✗ It does not know what a "session", "dossier", "slot" or "turn" is.
 *   ✗ It never calls /api/sessions/.../turn or /turn/stream.
 *   ✗ It never talks to the LLM (Ollama / OpenAI-compatible).
 *   The ONLY backend routes it touches are the speech ones:
 *        POST /api/voice/preflight   (is cloud STT reachable? else use browser STT)
 *        POST /api/stt               (audio blob  → text)
 *        POST /api/tts               (text        → mp3)
 *
 * HOW A SPOKEN ANSWER REACHES THE LLM  (the part that is easy to miss)
 * -------------------------------------------------------------------
 * voice.js hands the finished transcript to the HOST through the injected
 * callback `onTranscript`. The host (static/app.js) decides what to do with it.
 * Today it forwards it to `sendText()` (features/interview/ui/chat.js), which calls the backend.
 *
 *   ┌───────────────────────── BROWSER ─────────────────────────┐
 *   │                                                           │
 *   │  user speaks                                              │
 *   │      │                                                    │
 *   │      ▼                                                    │
 *   │  voice.js ── STT ──► "Wir sind zwei Gründer"  (a string)  │
 *   │      │      (Web Speech locally, or POST /api/stt)        │
 *   │      │                                                    │
 *   │      │  onTranscript(text)      ◄── INJECTED BY THE HOST  │
 *   │      ▼          ═════════════════ voice.js stops here ═══ │
 *   │  app.js: onTranscript → chat.js sendText(text)            │
 *   │      │      (typing in the text box calls sendText too)   │
 *   │      │                                                    │
 *   └──────┼────────────────────────────────────────────────────┘
 *          │  POST /api/sessions/{id}/turn/stream   (SSE)
 *          ▼
 *   ┌───────────────────────── BACKEND ─────────────────────────┐
 *   │  interview/routes.py  turn_stream()                       │
 *   │    └► interview/pipeline.py  InterviewPipeline.stream_turn│
 *   │         ├─ LLM call #1  extract facts into the dossier    │
 *   │         └─ LLM call #2  write the reply  (STREAMED)       │
 *   │              └► interview/llm.py ConfigurableLLM.stream() │
 *   │                   └► Ollama / OpenAI-compatible server    │
 *   └──────┬────────────────────────────────────────────────────┘
 *          │  SSE:  event: delta  (reply chunks)  …  event: done
 *          ▼
 *   ┌───────────────────────── BROWSER ─────────────────────────┐
 *   │  chat.js sendText(): paints chunks into the chat bubble,  │
 *   │  then, on `done`, calls  speak(reply)  ◄── back into here │
 *   │      │                                                    │
 *   │      ▼                                                    │
 *   │  voice.js speak(): POST /api/tts → mp3 → <audio>.play()   │
 *   └───────────────────────────────────────────────────────────┘
 *
 * So the loop is:  voice.js (hear) → chat.js (think, via backend) → voice.js (speak).
 * voice.js is the ears and the mouth. The brain lives behind chat.js.
 *
 * WHY IT IS BUILT THIS WAY
 * ------------------------
 * Dependency injection keeps this module reusable and testable: it can be wired
 * to any "what do I do with a transcript?" handler. If you want to change what
 * happens after the user speaks, change the host's `onTranscript`, NOT this file.
 *
 * WHERE TO LOOK NEXT
 * ------------------
 *   UI host      static/app.js (wiring) + features/interview/ui/chat.js sendText()
 *   HTTP client  static/shared/api.js             → api(), apiStream() (SSE reader)
 *   Endpoint     features/interview/routes.py     → turn_stream()
 *   Orchestrator features/interview/pipeline.py   → InterviewPipeline.stream_turn()
 *   LLM client   features/interview/llm.py        → ConfigurableLLM.stream()
 *
 * LIVE PATHS (kept deliberately simple for fluency)
 * ------------------------------------------------
 * STT: interim + partial finals paint into a live user chat bubble in #qaList
 *      (not the composer). Cloud STT runs a silent Web Speech “shadow” for that
 *      preview while MediaRecorder + /api/stt produce the final transcript.
 * TTS: beginSpeakStream / pushSpeakStream / endSpeakStream speak sentence-sized
 *      chunks via the same POST /api/tts as soon as a .?!… lands in the reply
 *      stream (queue + one clip at a time — no true audio byte stream).
 */
import { api } from "../../shared/api.js";
import { clampSpeed, fmtTime, langTag } from "../../shared/format.js";

const PREFLIGHT_TTL_MS = 20000;

/**
 * Create the voice controller.
 *
 * Everything the controller needs from the outside world is INJECTED here —
 * that is the whole contract between voice.js and the app. Nothing is imported
 * from the session/dossier/LLM side.
 *
 * @param {object} deps
 * @param {object} deps.prefs               shared preferences object (read live)
 * @param {HTMLTextAreaElement|HTMLInputElement} [deps.textInput]  typed composer only (not STT)
 * @param {() => boolean} deps.canListen     false while no chat session is active
 * @param {() => string} deps.getLanguage    language code ("de"/"en") STT and TTS must use now
 *
 * @param {(text: string) => Promise<void>|void} deps.onTranscript
 *   >>> THE HAND-OFF TO THE LLM <<<
 *   Called with the FINAL transcript once the user stops talking.
 *   voice.js does nothing with the text itself; it just calls this and awaits it.
 *   The host wires it to `sendText(text)` (features/interview/ui/chat.js), which POSTs to
 *   /api/sessions/{id}/turn/stream. That is the first and only place the
 *   transcript meets the backend/LLM.
 *   Called from two places: cloud STT (`mediaRecorder.onstop`) and
 *   browser STT (`recognition.onend`).
 *
 * @param {() => void} deps.onProviderChange STT provider label changed
 * @param {() => void} deps.onAbort          user cancelled a pending turn
 * @param {() => boolean} [deps.confirmInterrupt]  warn before killing in-flight turn/extract
 */
export function createVoice({
  prefs, textInput, canListen, getLanguage, onTranscript, onProviderChange, onAbort, confirmInterrupt,
}) {
  const voiceStatus = document.getElementById("voiceStatus");
  const voiceStatusTop = document.getElementById("voiceStatusTop");
  const voiceOrb = document.getElementById("voiceOrb");
  const voiceOrbTop = document.getElementById("voiceOrbTop");

  /** @type {'idle'|'listening'|'thinking'|'speaking'} */
  let voicePhase = "idle";
  let sttProvider = "browser";
  let sttProviders = ["browser"];
  let audioEl = null;
  let activeRecognition = null;
  let mediaRecorder = null;
  let mediaStream = null;
  let mediaChunks = [];
  let silenceTimer = null;
  let speechSeen = false;
  let preflightCache = { at: 0, stt: null, use: null, ok: false };
  /** Cloud-record only: Web Speech paints interim text; final transcript still from /api/stt. */
  let interimShadow = null;
  /** Live STT bubble in #qaList (provisional user message while mic is open). */
  let liveWrap = null;
  let liveTranscript = "";
  /** Sentence-chunk TTS while the reply SSE streams. */
  let speakGen = 0;
  let speakQueue = [];
  let speakPumping = false;
  let speakStreamOn = false;
  let speakForce = false;
  let speakBuf = "";
  let speakJoined = "";
  let waveRaf = 0;
  let waveAnalyser = null;
  let waveCtx = null;
  let meterStream = null; // browser-STT path: mic only for waveform

  const setStatus = (s) => {
    voiceStatus.textContent = s;
    if (voiceStatusTop) voiceStatusTop.textContent = s;
  };
  const micButtons = () => [document.getElementById("micBtn")].filter(Boolean);
  const syncListenBar = (listening) => {
    const dock = document.getElementById("speakDock");
    const bar = document.getElementById("listenBar");
    dock?.classList.toggle("is-listening", Boolean(listening));
    if (bar) bar.hidden = !listening;
  };
  const syncMicLabels = () => {
    const de = String(getLanguage?.() || "de").toLowerCase().startsWith("de");
    let label = de ? "Sprechen" : "Speak";
    let title = de ? "Antwort diktieren" : "Dictate a reply";
    let live = false;
    let thinking = false;
    let speaking = false;
    if (voicePhase === "listening") {
      label = de ? "Stopp" : "Stop";
      title = de ? "Aufnahme beenden und senden" : "Stop recording and send";
      live = true;
    } else if (voicePhase === "speaking") {
      label = de ? "Stimme stoppen" : "Stop voice";
      title = de ? "Agentenstimme stoppen" : "Stop agent voice";
      speaking = true;
    } else if (voicePhase === "thinking") {
      label = de ? "Abbrechen" : "Cancel";
      title = de ? "Verarbeitung abbrechen" : "Cancel processing";
      thinking = true;
    }
    micButtons().forEach((btn) => {
      btn.classList.toggle("is-live", live);
      btn.classList.toggle("is-thinking", thinking);
      btn.classList.toggle("is-speaking", speaking);
      btn.classList.toggle("recording", live || speaking);
      const labelEl = btn.querySelector(".mic-btn__label");
      if (labelEl) labelEl.textContent = label;
      else btn.textContent = label;
      btn.setAttribute("aria-pressed", live || speaking || thinking ? "true" : "false");
      btn.title = title;
    });
    syncListenBar(live);
  };
  const setVoicePhase = (phase, statusText) => {
    voicePhase = phase;
    const listening = phase === "listening";
    const speaking = phase === "speaking";
    const thinking = phase === "thinking";
    [voiceOrb, voiceOrbTop].forEach((el) => {
      if (!el) return;
      el.classList.toggle("listening", listening);
      el.classList.toggle("speaking", speaking);
      el.classList.toggle("thinking", thinking);
    });
    syncMicLabels();
    if (statusText != null) setStatus(statusText);
    else if (phase === "idle") setStatus("Ready");
    else if (phase === "listening") setStatus("Listening…");
    else if (phase === "thinking") setStatus("Thinking…");
    else if (phase === "speaking") setStatus("Speaking…");
  };

  function stopWaveform() {
    if (waveRaf) cancelAnimationFrame(waveRaf);
    waveRaf = 0;
    waveAnalyser = null;
    if (waveCtx) {
      try { waveCtx.close(); } catch { /* ignore */ }
      waveCtx = null;
    }
    if (meterStream) {
      meterStream.getTracks().forEach((t) => t.stop());
      meterStream = null;
    }
    const canvas = document.getElementById("listenWave");
    if (canvas) {
      const c = canvas.getContext("2d");
      if (c) c.clearRect(0, 0, canvas.width, canvas.height);
    }
  }

  function startWaveform(stream) {
    stopWaveform();
    const canvas = document.getElementById("listenWave");
    if (!canvas || !stream) return;
    try {
      waveCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = waveCtx.createMediaStreamSource(stream);
      waveAnalyser = waveCtx.createAnalyser();
      waveAnalyser.fftSize = 256;
      source.connect(waveAnalyser);
      const data = new Uint8Array(waveAnalyser.frequencyBinCount);
      const draw = () => {
        waveRaf = requestAnimationFrame(draw);
        if (!waveAnalyser) return;
        waveAnalyser.getByteFrequencyData(data);
        const c = canvas.getContext("2d");
        if (!c) return;
        const w = canvas.width;
        const h = canvas.height;
        c.clearRect(0, 0, w, h);
        const bars = 28;
        const gap = 2;
        const bw = (w - gap * (bars - 1)) / bars;
        for (let i = 0; i < bars; i++) {
          const idx = Math.floor((i / bars) * data.length);
          const mag = data[idx] / 255;
          const bh = Math.max(3, mag * h * 0.92);
          const x = i * (bw + gap);
          const y = (h - bh) / 2;
          c.fillStyle = `rgba(180, 40, 90, ${0.35 + mag * 0.55})`;
          c.fillRect(x, y, bw, bh);
        }
      };
      draw();
    } catch {
      /* waveform optional */
    }
  }
  const sttLabel = () => ({
    elevenlabs: "ElevenLabs STT",
    deepgram: "Deepgram",
    browser: "Web Speech",
  }[sttProvider] || sttProvider);

  function resolveSttProvider() {
    if (prefs.stt && prefs.stt !== "auto" && sttProviders.includes(prefs.stt)) {
      return prefs.stt;
    }
    if (sttProviders.includes("elevenlabs")) return "elevenlabs";
    if (sttProviders.includes("deepgram")) return "deepgram";
    return "browser";
  }

  function applySttProvider() {
    sttProvider = resolveSttProvider();
    const sel = document.getElementById("sttSel");
    if (sel) {
      [...sel.options].forEach((opt) => {
        opt.disabled = opt.value !== "browser" && !sttProviders.includes(opt.value);
      });
      sel.value = sttProviders.includes(prefs.stt) ? prefs.stt : sttProvider;
    }
    onProviderChange();
  }

  function setProviders(list) { sttProviders = list; }
  function useBrowser() { sttProvider = "browser"; }

  function clearSilenceWatch() {
    if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
  }

  function clearLiveBubble() {
    liveTranscript = "";
    if (liveWrap?.isConnected) liveWrap.remove();
    liveWrap = null;
    qaListCleanupOrphans();
  }

  function qaListCleanupOrphans() {
    document.querySelectorAll(".team-qa--live").forEach((el) => {
      if (el !== liveWrap) el.remove();
    });
  }

  /** Provisional user bubble while listening — grows with interim + finals. */
  function ensureLiveBubble() {
    const qaList = document.getElementById("qaList");
    const chatScroll = document.getElementById("chatScroll");
    if (!qaList) return null;
    qaListCleanupOrphans();
    if (liveWrap?.isConnected) return liveWrap;
    liveWrap = document.createElement("div");
    liveWrap.className = "team-qa team-qa--live";
    liveWrap.setAttribute("aria-live", "polite");
    liveWrap.setAttribute("aria-busy", "true");
    const stamp = fmtTime(new Date().toISOString());
    liveWrap.innerHTML = `<div class="team-qa__a">
      <div class="team-qa__a-avatar user">Du</div>
      <div class="team-qa__a-bubble user-bubble user-bubble--live">
        <p></p>
        ${stamp ? `<time class="team-qa__time">${stamp}</time>` : ""}
      </div>
    </div>`;
    qaList.appendChild(liveWrap);
    if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;
    return liveWrap;
  }

  /** Show full STT text as a live chat bubble (composer stays for typing only). */
  function paintSttPreview(text) {
    const next = String(text || "").replace(/\s+/g, " ").trim();
    liveTranscript = next;
    if (!next) {
      // Keep an empty waiting bubble while mic is still open.
      if (voicePhase === "listening") {
        const wrap = ensureLiveBubble();
        const p = wrap?.querySelector("p");
        if (p) p.textContent = "";
        return;
      }
      clearLiveBubble();
      return;
    }
    const wrap = ensureLiveBubble();
    const p = wrap?.querySelector("p");
    if (p) p.textContent = next;
    const chatScroll = document.getElementById("chatScroll");
    if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  function takeLiveTranscript() {
    const t = liveTranscript.trim();
    clearLiveBubble();
    return t;
  }

  function stopInterimShadow() {
    if (!interimShadow) return;
    const rec = interimShadow;
    interimShadow = null;
    try { rec.onend = null; rec.onerror = null; rec.onresult = null; rec.stop(); } catch { /* ignore */ }
  }

  function startInterimShadow() {
    stopInterimShadow();
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) return;
    const recognition = new Ctor();
    interimShadow = recognition;
    recognition.lang = langTag(getLanguage());
    recognition.interimResults = true;
    recognition.continuous = true;
    let finalText = "";
    recognition.onresult = (ev) => {
      if (interimShadow !== recognition) return;
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += `${t} `;
        else interim += t;
      }
      // Live UI only — finals + current interim (whole transcript, not either/or).
      paintSttPreview(`${finalText}${interim}`);
    };
    recognition.onerror = () => {
      if (interimShadow === recognition) interimShadow = null;
    };
    recognition.onend = () => {
      if (interimShadow === recognition) interimShadow = null;
    };
    try { recognition.start(); } catch { interimShadow = null; }
  }

  function stopMicCapture({ keepPhase } = {}) {
    clearSilenceWatch();
    speechSeen = false;
    stopInterimShadow();
    stopWaveform();
    if (activeRecognition) {
      const rec = activeRecognition;
      activeRecognition = null;
      try { rec.onend = null; rec.onerror = null; rec.onresult = null; rec.stop(); } catch { /* already stopped */ }
    }
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch { /* ignore */ }
    }
    mediaRecorder = null;
    mediaChunks = [];
    if (mediaStream) {
      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
    }
    if (!keepPhase && voicePhase === "listening") setVoicePhase("idle");
  }

  function stopSpeak() {
    speakGen += 1;
    speakStreamOn = false;
    speakBuf = "";
    speakJoined = "";
    speakQueue = [];
    speakPumping = false;
    if (!audioEl) return;
    const el = audioEl;
    audioEl = null;
    el.onended = null;
    el.onerror = null;
    try { el.pause(); } catch { /* ignore */ }
    el.removeAttribute("src");
    try { el.load(); } catch { /* ignore */ }
  }

  function clearAwaitingGreeting() {
    document.getElementById("app")?.classList.remove("awaiting-greeting");
  }

  function afterSpeak() {
    clearAwaitingGreeting();
    if (voicePhase === "speaking") setVoicePhase("idle");
    if (prefs.auto && canListen()) startListening();
  }

  async function playTtsClip(text, gen) {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        language: getLanguage(),
        stability: prefs.stability,
        similarity: prefs.similarity,
        speed: clampSpeed(prefs.speed),
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    if (gen !== speakGen) return;
    const url = URL.createObjectURL(await res.blob());
    if (gen !== speakGen) {
      URL.revokeObjectURL(url);
      return;
    }
    await new Promise((resolve, reject) => {
      const el = new Audio(url);
      audioEl = el;
      el.onended = () => {
        URL.revokeObjectURL(url);
        if (audioEl === el) audioEl = null;
        resolve();
      };
      el.onerror = () => {
        URL.revokeObjectURL(url);
        if (audioEl === el) audioEl = null;
        reject(new Error("TTS playback failed"));
      };
      el.play().catch(reject);
    });
  }

  async function pumpSpeakQueue() {
    if (speakPumping) return;
    speakPumping = true;
    const gen = speakGen;
    while (speakQueue.length && gen === speakGen) {
      const piece = speakQueue.shift();
      try {
        setVoicePhase("speaking");
        await playTtsClip(piece, gen);
      } catch (err) {
        if (gen !== speakGen) break;
        let msg = String(err.message || err);
        try { msg = JSON.parse(msg).detail || msg; } catch { /* plain */ }
        setVoicePhase("idle", `TTS failed — ${String(msg).slice(0, 120)}`);
        speakQueue = [];
        speakStreamOn = false;
        speakPumping = false;
        clearAwaitingGreeting();
        return;
      }
    }
    speakPumping = false;
    if (gen === speakGen && !speakStreamOn && !speakQueue.length) afterSpeak();
  }

  function enqueueSpeak(text) {
    const t = (text || "").trim();
    if (!t) return;
    speakJoined = speakJoined ? `${speakJoined} ${t}` : t;
    speakQueue.push(t);
    void pumpSpeakQueue();
  }

  /** Start sentence-chunk TTS for an in-flight reply stream (chat.js deltas). */
  function beginSpeakStream({ force = false } = {}) {
    stopSpeak();
    speakForce = force;
    speakStreamOn = true;
    speakBuf = "";
    speakJoined = "";
  }

  /** Feed one reply delta; speaks completed sentences as soon as they land. */
  function pushSpeakStream(chunk) {
    if (!speakStreamOn || (!prefs.voice && !speakForce) || !chunk) return;
    speakBuf += chunk;
    for (;;) {
      // Never speak a trailing / partial [[dossier:…]] gate.
      let visible = speakBuf.replace(/\s*\[\[\s*dossier\s*:\s*(yes|no)\s*\]\]\s*$/i, "");
      const hold = visible.search(/\[\[\s*dossier/i);
      if (hold >= 0) visible = visible.slice(0, hold);
      const m = visible.match(/^([\s\S]*?[.!?…]+)(\s+|$)/);
      if (!m) break;
      const sentence = m[1].trim();
      const eaten = m[0].length;
      speakBuf = speakBuf.slice(eaten);
      if (sentence) enqueueSpeak(sentence);
    }
  }

  /** Finish stream: speak any remainder (authoritative clean `finalText` from event: reply). */
  function endSpeakStream(finalText) {
    speakStreamOn = false;
    if ((!prefs.voice && !speakForce)) {
      if (!speakPumping && !speakQueue.length) {
        setVoicePhase("idle");
        afterSpeak();
      }
      return;
    }
    const clean = String(finalText || "").trim();
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    // Drop any unfinished buffer — finalText is authoritative.
    speakBuf = "";
    if (!clean) {
      if (!speakPumping && !speakQueue.length) afterSpeak();
      return;
    }
    const a = norm(speakJoined);
    const b = norm(clean);
    if (!a) {
      enqueueSpeak(clean);
    } else if (b.startsWith(a) && b.length > a.length) {
      enqueueSpeak(b.slice(a.length).trim());
    } else if (a !== b && !a.startsWith(b)) {
      // Stream text drifted from final reply — restart with the clean answer (avoid silence).
      const force = speakForce;
      stopSpeak();
      speakForce = force;
      enqueueSpeak(clean);
    }
    if (!speakPumping && !speakQueue.length) afterSpeak();
  }

  /**
   * TEXT → VOICE (one shot). Prefer begin/push/endSpeakStream while reply SSE is live.
   * @param {string} text @param {{force?: boolean}} [opts] force: speak even if „Antworten vorlesen“ is off
   */
  async function speak(text, { force = false } = {}) {
    beginSpeakStream({ force });
    speakStreamOn = false;
    if ((!prefs.voice && !force) || !text) {
      setVoicePhase("idle");
      afterSpeak();
      return;
    }
    enqueueSpeak(text);
  }

  async function voicePreflight(preferredStt) {
    const now = Date.now();
    if (
      preflightCache.ok
      && now - preflightCache.at < PREFLIGHT_TTL_MS
      && preflightCache.stt === preferredStt
    ) {
      return preflightCache;
    }
    const data = await api("/api/voice/preflight", {
      method: "POST",
      body: JSON.stringify({
        stt: preferredStt || "auto",
        // Mic path: STT only. TTS is checked when speaking replies — not on Sprechen.
        check_tts: false,
      }),
    });
    const use = (data.mic && data.mic.use) || (data.stt && data.stt.provider) || "browser";
    preflightCache = {
      at: now,
      stt: preferredStt,
      use,
      ok: Boolean(data.ok || use === "browser"),
      raw: data,
    };
    return preflightCache;
  }

  async function transcribeCloud(blob) {
    const fd = new FormData();
    fd.append("audio", blob, "utterance.webm");
    fd.append("language", getLanguage());
    fd.append("provider", sttProvider === "browser" ? "auto" : sttProvider);
    fd.append("fallback", "1");
    const res = await fetch("/api/stt", { method: "POST", body: fd });
    const rawText = await res.text();
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch { /* plain */ }
    if (!res.ok) {
      const detail = data && data.detail;
      const msg = (detail && detail.message) || (typeof detail === "string" ? detail : rawText);
      const err = new Error(msg || "STT failed");
      err.fallback = (detail && detail.fallback) || "browser";
      throw err;
    }
    if (data.provider) {
      sttProvider = data.provider;
      onProviderChange();
    }
    return (data.text || "").trim();
  }

  function watchSilence(stream) {
    clearSilenceWatch();
    speechSeen = false;
    startWaveform(stream);
    let audioCtx;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let quietMs = 0;
      const tickMs = 100;
      const quietNeed = 1200;
      const speechThreshold = 0.018;
      silenceTimer = setInterval(() => {
        if (!mediaRecorder || mediaRecorder.state !== "recording") return;
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        if (rms > speechThreshold) {
          speechSeen = true;
          quietMs = 0;
        } else if (speechSeen) {
          quietMs += tickMs;
          if (quietMs >= quietNeed) stopCloudRecording();
        }
      }, tickMs);
      mediaRecorder?.addEventListener("stop", () => {
        try { audioCtx.close(); } catch { /* ignore */ }
      }, { once: true });
    } catch {
      /* silence detection optional */
    }
  }

  function stopCloudRecording() {
    clearSilenceWatch();
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try { mediaRecorder.stop(); } catch { /* ignore */ }
    }
  }

  async function startCloudListening() {
    if (voicePhase === "listening" && mediaRecorder) {
      stopCloudRecording();
      return;
    }
    stopSpeak();
    stopMicCapture({ keepPhase: true });
    setVoicePhase("listening");
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      mediaChunks = [];
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : (MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "");
      mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
      mediaRecorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) mediaChunks.push(ev.data); };
      mediaRecorder.onerror = () => {
        stopMicCapture({ keepPhase: true });
        setVoicePhase("idle", "Microphone error");
      };
      mediaRecorder.onstop = async () => {
        clearSilenceWatch();
        stopInterimShadow();
        stopWaveform();
        const blob = new Blob(mediaChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
        if (mediaStream) {
          mediaStream.getTracks().forEach((t) => t.stop());
          mediaStream = null;
        }
        mediaRecorder = null;
        mediaChunks = [];
        if (!blob.size) {
          clearLiveBubble();
          setVoicePhase("idle", "Nothing heard");
          return;
        }
        setVoicePhase("thinking", `Transcribing (${sttLabel()})…`);
        try {
          const text = await transcribeCloud(blob);
          clearLiveBubble();
          if (text) {
            // ── HAND-OFF (cloud STT path) ─────────────────────────────────────
            // voice.js ends here. The host decides what a transcript means;
            // in this app that is sendText() → POST .../turn/stream → LLM.
            await onTranscript(text);
          } else {
            setVoicePhase("idle", "Nothing recognized — try again");
          }
        } catch (err) {
          clearLiveBubble();
          // Cloud STT failed after record — fall back to browser for next attempt.
          preflightCache = { at: 0, stt: null, use: null, ok: false };
          sttProvider = "browser";
          onProviderChange();
          setVoicePhase("idle", "Cloud STT down → Web Speech. Tap Speak again.");
        }
      };
      mediaRecorder.start(250);
      watchSilence(mediaStream);
      // Live chat bubble while cloud records (shadow Web Speech; final = /api/stt).
      paintSttPreview("");
      startInterimShadow();
      setStatus("Listening… (live bubble · Stop = send)");
    } catch (err) {
      stopMicCapture({ keepPhase: true });
      setVoicePhase("idle", `Microphone: ${String(err.message || err).slice(0, 100)}`);
    }
  }

  function startBrowserListening() {
    if (voicePhase === "listening" && activeRecognition) {
      try { activeRecognition.stop(); } catch { /* ignore */ }
      return;
    }
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) { setVoicePhase("idle", "Microphone unavailable — please type"); return; }
    stopSpeak();
    stopMicCapture({ keepPhase: true });
    const recognition = new Ctor();
    activeRecognition = recognition;
    recognition.lang = langTag(getLanguage());
    recognition.interimResults = true;
    // Continuous until Stop (or silence auto-stop via onend after pause chains).
    recognition.continuous = true;
    let finalText = "";
    recognition.onstart = () => {
      setVoicePhase("listening");
      paintSttPreview("");
    };
    recognition.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += `${t} `; else interim += t;
      }
      // Whole transcript: committed finals + live interim (was || and clipped the rest).
      paintSttPreview(`${finalText}${interim}`);
    };
    recognition.onerror = () => {
      if (activeRecognition === recognition) activeRecognition = null;
      stopWaveform();
      clearLiveBubble();
      if (voicePhase === "listening") setVoicePhase("idle");
    };
    recognition.onend = async () => {
      if (activeRecognition === recognition) activeRecognition = null;
      stopWaveform();
      if (voicePhase !== "listening") {
        clearLiveBubble();
        return;
      }
      const t = takeLiveTranscript();
      // ── HAND-OFF (browser Web Speech path) ──────────────────────────────
      // Same contract as the cloud path above: pass the string out, stop here.
      if (t) await onTranscript(t);
      else setVoicePhase("idle");
    };
    try {
      recognition.start();
      // Waveform meter (Web Speech has no audio stream of its own).
      navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      }).then((stream) => {
        if (activeRecognition !== recognition) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        meterStream = stream;
        startWaveform(stream);
      }).catch(() => { /* meter optional */ });
    } catch {
      activeRecognition = null;
      clearLiveBubble();
      setVoicePhase("idle", "Microphone busy");
    }
  }

  async function startListening() {
    if (!canListen()) { setStatus("Choose a session first"); return; }
    // Sprechen: kill TTS first — never start mic while agent still talks.
    stopSpeak();
    stopMicCapture({ keepPhase: true });
    sttProvider = resolveSttProvider();
    setVoicePhase("thinking", "Checking STT…");
    try {
      const pf = await voicePreflight(sttProvider);
      const use = pf.use || "browser";
      if (use !== sttProvider && use !== "browser") {
        sttProvider = use;
        onProviderChange();
      }
      if (!pf.ok || use === "browser" || sttProvider === "browser") {
        if (sttProvider !== "browser") {
          sttProvider = "browser";
          onProviderChange();
          setStatus("Cloud STT unreachable → Web Speech");
        }
        startBrowserListening();
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        sttProvider = "browser";
        startBrowserListening();
        return;
      }
      await startCloudListening();
    } catch (err) {
      // Fail closed to browser ASAP.
      sttProvider = "browser";
      onProviderChange();
      setVoicePhase("idle", `STT check failed → Web Speech (${String(err.message || err).slice(0, 80)})`);
      startBrowserListening();
    }
  }

  const stopVoice = () => {
    stopSpeak();
    stopMicCapture({ keepPhase: true });
    clearLiveBubble();
    onAbort();
    setVoicePhase("idle");
  };

  const onMicClick = () => {
    // Always cut TTS on mic interaction — Speak must not wait on speak().
    if (voicePhase === "speaking") {
      stopSpeak();
      clearAwaitingGreeting();
      setVoicePhase("idle");
      return;
    }
    if (voicePhase === "listening") {
      if (sttProvider === "elevenlabs" || sttProvider === "deepgram") stopCloudRecording();
      else if (activeRecognition) { try { activeRecognition.stop(); } catch { /* ignore */ } }
      else stopVoice();
      return;
    }
    if (voicePhase === "thinking") {
      if (confirmInterrupt && !confirmInterrupt()) return;
      stopVoice();
      return;
    }
    // New mic while extract/turn still runs in header — warn then abort.
    if (confirmInterrupt && !confirmInterrupt()) return;
    onAbort?.();
    startListening();
  };

  // Delegation: placeSpeakDock may recreate #listenStopBtn.
  document.addEventListener("click", (e) => {
    const stop = e.target?.closest?.("#listenStopBtn");
    if (!stop) return;
    e.preventDefault();
    if (voicePhase === "listening") onMicClick();
  });

  return {
    getPhase: () => voicePhase,
    setStatus,
    setVoicePhase,
    sttLabel,
    resolveSttProvider,
    applySttProvider,
    setProviders,
    useBrowser,
    stopMicCapture,
    stopSpeak,
    speak,
    beginSpeakStream,
    pushSpeakStream,
    endSpeakStream,
    onMicClick,
  };
}
