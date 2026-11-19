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
import { createNoiseGate } from "./wave-gate.js";

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
  let extractBusyInDock = false;
  /**
   * Which speak mode is active, made visible. `modeUi` comes from the selected driver (voice-mode.js):
   *   { pill: {de, en, live, connecting, icon, agent}, labels: { idle|listening|speaking: {de, en, titleDe, titleEn} }, stop: {de, en} }
   * null = classic push-to-talk. The pill sits next to the mic button, so it is obvious which button
   * you are pressing: "Antippen & sprechen" (classic) or "Live-Gespräch" (LiveKit).
   */
  let modeUi = null;
  const CLASSIC_PILL = { de: "🎙️ Antippen & sprechen", en: "🎙️ Tap & talk", live: false };

  /** Small LiveKit-style mark (three rounded bars) drawn in currentColor, so it follows the pill colour. */
  function livekitMark() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("class", "mode-pill__logo");
    svg.setAttribute("aria-hidden", "true");
    [[1.5, 6, 3, 8], [6.5, 2, 3, 12], [11.5, 5, 3, 6]].forEach(([x, y, w, h]) => {
      const bar = document.createElementNS(NS, "rect");
      bar.setAttribute("x", x); bar.setAttribute("y", y);
      bar.setAttribute("width", w); bar.setAttribute("height", h); bar.setAttribute("rx", 1.5);
      svg.appendChild(bar);
    });
    return svg;
  }

  function syncModePill(de) {
    const dock = document.getElementById("speakDock");
    if (!dock) return;
    let pill = document.getElementById("modePill");
    if (!pill) {
      pill = document.createElement("span");
      pill.id = "modePill";
      pill.className = "mode-pill";
      pill.setAttribute("role", "status");
      dock.prepend(pill);
    }
    const p = modeUi?.pill || CLASSIC_PILL;
    const lang = de ? "de" : "en";
    // In a call, say what the LiveKit agent is doing right now (listening / thinking / speaking).
    const doing = p.live ? p.agent?.[voicePhase]?.[lang] : "";
    const text = doing ? `${p[lang]} · ${doing}` : p[lang];
    const key = `${p.icon || ""}|${text}`;
    if (pill.dataset.key !== key) { // rebuild only on change (this runs on every phase tick)
      pill.dataset.key = key;
      pill.replaceChildren();
      if (p.icon === "livekit") pill.appendChild(livekitMark());
      if (p.live) {
        const dot = document.createElement("i");
        dot.className = "mode-pill__dot";
        pill.appendChild(dot);
      }
      pill.appendChild(document.createTextNode(text));
    }
    pill.classList.toggle("is-live", Boolean(p.live));
    pill.classList.toggle("is-connecting", Boolean(p.connecting));
    pill.dataset.mode = modeUi ? "livekit" : "classic";
  }

  function setModeUi(next) {
    modeUi = next || null;
    syncMicLabels();
  }

  const syncMicLabels = () => {
    const de = String(getLanguage?.() || "de").toLowerCase().startsWith("de");
    const dock = document.getElementById("speakDock");
    let label = de ? "Sprechen" : "Speak";
    let title = de ? "Antwort diktieren" : "Dictate a reply";
    let live = false;
    let thinking = false;
    let speaking = false;
    const extracting = Boolean(extractBusyInDock && voicePhase === "idle");
    if (voicePhase === "listening") {
      label = de ? "Stopp" : "Stop";
      title = de ? "Aufnahme beenden und senden" : "Stop recording and send";
      live = true;
    } else if (voicePhase === "speaking") {
      label = de ? "Stimme stoppen" : "Mute voice";
      title = de ? "Vorlesen überspringen (Dossier läuft weiter)" : "Skip audio playback (dossier update continues)";
      speaking = true;
    } else if (voicePhase === "thinking") {
      label = de ? "Verarbeitet… (Abbrechen)" : "Working… (Cancel)";
      title = de ? "Verarbeitung abbrechen" : "Cancel current request";
      thinking = true;
    } else if (extracting) {
      // Allow speaking freely while the dossier updates in the background!
      label = de ? "Sprechen" : "Speak";
      title = de
        ? "Jetzt schon sprechen (Dossier-Update läuft im Hintergrund weiter)"
        : "Speak now (dossier update continues in background)";
    }
    // Mode-specific wording (e.g. "Auflegen" in a live call instead of "Stopp").
    const phaseKey = voicePhase === "idle" ? "idle" : voicePhase;
    const o = modeUi?.labels?.[phaseKey];
    if (o) {
      label = de ? o.de : o.en;
      title = de ? o.titleDe : o.titleEn;
    }
    syncModePill(de);
    const stopBtn = document.getElementById("listenStopBtn");
    if (stopBtn && modeUi?.stop) stopBtn.textContent = de ? modeUi.stop.de : modeUi.stop.en;
    dock?.classList.toggle("is-thinking", thinking);
    dock?.classList.toggle("is-speaking", speaking);
    dock?.classList.toggle("is-extracting", extracting);
    micButtons().forEach((btn) => {
      btn.classList.toggle("is-live", live);
      btn.classList.toggle("is-thinking", thinking);
      btn.classList.toggle("is-speaking", speaking);
      btn.classList.toggle("is-extracting", extracting && !live && !speaking && !thinking);
      btn.classList.toggle("recording", live);
      if (o) btn.dataset.modeLabel = "1"; else delete btn.dataset.modeLabel;
      const labelEl = btn.querySelector(".mic-btn__label");
      // The generic i18n pass rewrites every [data-i18n] text: step aside while a mode owns the wording.
      if (labelEl) {
        if (o) labelEl.removeAttribute("data-i18n");
        else if (!labelEl.hasAttribute("data-i18n")) labelEl.setAttribute("data-i18n", "speak");
      }
      if (labelEl) labelEl.textContent = label;
      else btn.textContent = label;
      btn.setAttribute("aria-pressed", live || speaking || thinking ? "true" : "false");
      btn.title = title;
    });
    syncListenBar(live);
  };
  const setExtractBusy = (busy) => {
    const next = Boolean(busy);
    if (extractBusyInDock === next) return;
    extractBusyInDock = next;
    syncMicLabels();
  };
  const setVoicePhase = (phase, statusText) => {
    // In a live call "nothing is playing" means "mic open, listening", never "idle": the classic voice
    // (browser TTS fallback) sets idle on its own when it finishes, which used to leave the button on
    // "Live-Gespräch starten" while the pill still said LIVE.
    if (phase === "idle" && modeUi?.idleAs) {
      phase = modeUi.idleAs;
      queueMicrotask(() => modeUi?.onIdle?.());
    }
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

  /** Mic loudness 0..1 -> CSS var on the orbs, so the orb visibly "breathes" with your voice. */
  function setMicLevel(v) {
    const val = String(Math.max(0, Math.min(1, v || 0)).toFixed(3));
    [voiceOrb, voiceOrbTop].forEach((el) => el?.style.setProperty("--mic-level", val));
  }

  function stopWaveform() {
    setMicLevel(0);
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

  /** Animated waveform for Web Speech (without opening a competing getUserMedia stream). */
  function startSyntheticWaveform() {
    stopWaveform();
    const canvas = document.getElementById("listenWave");
    if (!canvas) return;
    let tick = 0;
    const draw = () => {
      waveRaf = requestAnimationFrame(draw);
      tick += 0.12;
      const c = canvas.getContext("2d");
      if (!c) return;
      const w = canvas.width;
      const h = canvas.height;
      c.clearRect(0, 0, w, h);
      setMicLevel(0.25 + 0.2 * Math.sin(tick));
      const bars = 28;
      const gap = 2;
      const bw = (w - gap * (bars - 1)) / bars;
      for (let i = 0; i < bars; i++) {
        const mag = 0.22 + 0.38 * Math.abs(Math.sin(tick + i * 0.45));
        const bh = Math.max(3, mag * h * 0.85);
        const x = i * (bw + gap);
        const y = (h - bh) / 2;
        c.fillStyle = `rgba(180, 40, 90, ${0.35 + mag * 0.5})`;
        c.fillRect(x, y, bw, bh);
      }
    };
    draw();
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
      const wave = new Uint8Array(waveAnalyser.fftSize);
      const gate = createNoiseGate();
      const draw = () => {
        waveRaf = requestAnimationFrame(draw);
        if (!waveAnalyser) return;
        waveAnalyser.getByteFrequencyData(data);
        const c = canvas.getContext("2d");
        if (!c) return;
        const w = canvas.width;
        const h = canvas.height;
        c.clearRect(0, 0, w, h);
        // Loudness of this frame, gated: room hum keeps the bars flat and the orb still.
        waveAnalyser.getByteTimeDomainData(wave);
        let sq = 0;
        for (let i = 0; i < wave.length; i++) { const v = (wave[i] - 128) / 128; sq += v * v; }
        const open = gate.update(Math.sqrt(sq / wave.length), voicePhase === "speaking");
        setMicLevel(open);
        const bars = 28;
        const gap = 2;
        const bw = (w - gap * (bars - 1)) / bars;
        for (let i = 0; i < bars; i++) {
          const idx = Math.floor((i / bars) * data.length);
          const mag = open > 0 ? data[idx] / 255 : 0;
          const bh = Math.max(3, mag * h * 0.92);
          const x = i * (bw + gap);
          const y = (h - bh) / 2;
          c.fillStyle = `rgba(30, 150, 160, ${0.35 + mag * 0.55})`;
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
    whisper: "Whisper (Browser)",
    deepgram: "Deepgram",
    browser: "Web Speech",
  }[sttProvider] || sttProvider);

  function resolveSttProvider() {
    // Both "browser" (Web Speech) and "whisper" run in the browser — always selectable!
    if (prefs.stt === "browser" || prefs.stt === "whisper") return prefs.stt;
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
        const always = opt.value === "browser" || opt.value === "whisper";
        opt.disabled = !always && !sttProviders.includes(opt.value);
      });
      sel.value = sttProvider;
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
    localTtsCache.clear();
    stopLocalTtsPlayback();
    try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
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
    // In a live call the mic is already open: classic push-to-talk must not start on top of it.
    if (modeUi?.idleAs) return;
    // You can speak while dossier extract runs in the background!
    if (prefs.auto && canListen()) startListening();
  }

  let cloudTtsDown = false;
  /** AudioContext playback for local Transformers.js TTS. */
  let localTtsPlayback = null;

  function resolveTtsProvider() {
    const v = String(prefs.tts || "local").toLowerCase();
    if (v === "transformers") return "local";
    if (v === "browser" || v === "elevenlabs" || v === "local") return v;
    return "local";
  }

  function stopLocalTtsPlayback() {
    if (!localTtsPlayback) return;
    const cur = localTtsPlayback;
    localTtsPlayback = null;
    try { cur.src.stop(); } catch { /* ignore */ }
    try { cur.ctx.close(); } catch { /* ignore */ }
  }

  function playAudioSamples(samples, sampleRate, gen) {
    return new Promise((resolve, reject) => {
      if (gen !== speakGen) {
        resolve();
        return;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) {
        reject(new Error("No AudioContext"));
        return;
      }
      const ctx = new Ctx();
      const data = samples instanceof Float32Array ? samples : new Float32Array(samples || []);
      if (!data.length) {
        try { ctx.close(); } catch { /* ignore */ }
        resolve();
        return;
      }
      const buf = ctx.createBuffer(1, data.length, Number(sampleRate) || 16000);
      buf.copyToChannel(data, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = clampSpeed(prefs.speed);
      src.connect(ctx.destination);
      const done = () => {
        if (localTtsPlayback && localTtsPlayback.src === src) localTtsPlayback = null;
        try { ctx.close(); } catch { /* ignore */ }
        resolve();
      };
      src.onended = done;
      localTtsPlayback = { ctx, src };
      try {
        src.start();
      } catch (err) {
        done();
        reject(err);
      }
    });
  }

  /** text -> {gen, p}: sentences are synthesized AHEAD of playback, so sentence 2 is ready when 1 ends. */
  const localTtsCache = new Map();

  function synthesizeLocal(text) {
    return import("../../shared/model-manager.js").then(async ({ modelManager }) => {
      const lang = getLanguage();
      await modelManager.setTtsLanguage(lang);
      await modelManager.ensureLoaded("tts");
      return modelManager.synthesize(text, lang);
    });
  }

  function prefetchLocalTts(text) {
    if (resolveTtsProvider() !== "local" || cloudTtsDown || localTtsCache.has(text)) return;
    const p = synthesizeLocal(text);
    p.catch(() => { /* surfaces where it is played */ });
    localTtsCache.set(text, { gen: speakGen, p });
  }

  async function playLocalTts(text, gen) {
    const { modelManager } = await import("../../shared/model-manager.js");
    const st = modelManager.getState("tts");
    if (st?.state !== "ready" && st?.state !== "running") {
      setStatus("Loading TTS…");
    }
    const hit = localTtsCache.get(text);
    localTtsCache.delete(text);
    const result = await (hit && hit.gen === gen ? hit.p : synthesizeLocal(text));
    if (gen !== speakGen) return;
    if (gen !== speakGen) return;
    const audio = result?.audio;
    const rate = result?.sampling_rate || 16000;
    await playAudioSamples(audio, rate, gen);
  }

  /** Browser SpeechSynthesis fallback when ElevenLabs TTS quota/network fails. */
  function playBrowserTts(text, gen) {
    return new Promise((resolve) => {
      if (!window.speechSynthesis || gen !== speakGen) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(safetyTimer);
        resolve();
      };
      // Safety timer: Chromium's SpeechSynthesis sometimes drops `onend`; never hang the queue!
      const safetyTimer = setTimeout(done, Math.min(12000, Math.max(2500, text.length * 75)));
      try {
        if (window.speechSynthesis.speaking) {
          window.speechSynthesis.cancel();
        }
        const u = new SpeechSynthesisUtterance(text);
        // Keep a strong reference on window so Chrome GC never collects `u` mid-speech.
        window.__activeUtterance = u;
        u.lang = langTag(getLanguage());
        u.rate = clampSpeed(prefs.speed);
        u.onend = done;
        u.onerror = done;
        window.speechSynthesis.speak(u);
      } catch {
        done();
      }
    });
  }

  async function playTtsClip(text, gen) {
    const provider = resolveTtsProvider();
    if (provider === "local") {
      try {
        await playLocalTts(text, gen);
        return;
      } catch (err) {
        console.warn("[tts] local model failed, falling back to Web Speech", err);
        await playBrowserTts(text, gen);
        return;
      }
    }
    if (provider === "browser" || cloudTtsDown) {
      await playBrowserTts(text, gen);
      return;
    }
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
    if (!res.ok) {
      // Cloud TTS failed (e.g. ElevenLabs 0 credits remaining) -> remember & speak via browser TTS!
      cloudTtsDown = true;
      await playBrowserTts(text, gen);
      return;
    }
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
    if (gen !== speakGen) return; // stopSpeak() already reset the pump; a newer one may be running
    speakPumping = false;
    if (!speakStreamOn && !speakQueue.length) afterSpeak();
  }

  function enqueueSpeak(text) {
    const t = (text || "").trim();
    if (!t) return;
    speakJoined = speakJoined ? `${speakJoined} ${t}` : t;
    speakQueue.push(t);
    prefetchLocalTts(t);
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
      // Never speak a trailing / partial [[dossier:…]] or [[intake:end]] gate.
      let visible = speakBuf
        .replace(/\s*\[\[\s*dossier\s*:\s*(yes|no)\s*\]\]\s*$/i, "")
        .replace(/\s*\[\[\s*intake\s*:\s*end\s*\]\]\s*$/i, "");
      const hold = visible.search(/\[\[\s*(dossier|intake)/i);
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
    const stripGates = (s) => String(s || "")
      .replace(/\s*\[\[\s*dossier\s*:\s*(yes|no)\s*\]\]\s*/gi, " ")
      .replace(/\s*\[\[\s*intake\s*:\s*end\s*\]\]\s*/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const clean = stripGates(finalText);
    // Drop any unfinished buffer — finalText is authoritative.
    speakBuf = "";
    if (!clean) {
      if (!speakPumping && !speakQueue.length) {
        setVoicePhase("idle");
        afterSpeak();
      }
      return;
    }
    // Transition out of "thinking" immediately once reply text is ready to speak, even while
    // the /api/tts fetch is in flight — so Updating dossier never sees voicePhase === "thinking".
    if (voicePhase === "thinking") setVoicePhase("speaking");
    const a = stripGates(speakJoined);
    const b = clean;
    if (!a) {
      enqueueSpeak(clean);
    } else if (b.startsWith(a) && b.length > a.length) {
      enqueueSpeak(b.slice(a.length).trim());
    } else if (a !== b && !a.startsWith(b)) {
      // Only enqueue if nothing is currently playing/queued; never kill active TTS mid-sentence!
      if (!audioEl && !speakPumping && !speakQueue.length) {
        enqueueSpeak(clean);
      }
    }
    if (!speakPumping && !speakQueue.length && !audioEl) {
      setVoicePhase("idle");
      afterSpeak();
    }
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

  async function transcribeWhisper(blob) {
    const { modelManager } = await import("../../shared/model-manager.js");
    await modelManager.ensureLoaded("whisper");
    const audio = await modelManager.decodeAudioBlob(blob);
    return modelManager.transcribe(audio, getLanguage());
  }

  async function transcribeCloud(blob) {
    if (sttProvider === "whisper") return transcribeWhisper(blob);
    const fd = new FormData();
    fd.append("audio", blob, "utterance.webm");
    fd.append("language", getLanguage());
    fd.append("provider", sttProvider === "browser" ? "auto" : sttProvider);
    fd.append("fallback", "1");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let res;
    let rawText = "";
    try {
      res = await fetch("/api/stt", { method: "POST", body: fd, signal: ctrl.signal });
      rawText = await res.text();
    } finally {
      clearTimeout(timer);
    }
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

  /** Waveform meter only — recording ends via #listenStopBtn (or mic), never silence auto-stop. */
  function watchRecordingMeter(stream) {
    clearSilenceWatch();
    speechSeen = false;
    startWaveform(stream);
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
        // Save the shadow Web Speech transcript BEFORE clearing the live bubble, so if
        // cloud STT fails (e.g. ElevenLabs 0 credits / 502), we still have what was spoken!
        const shadowText = liveTranscript.trim();
        try {
          const text = await transcribeCloud(blob);
          clearLiveBubble();
          const finalOut = text || shadowText;
          if (finalOut) {
            setVoicePhase("idle");
            await onTranscript(finalOut);
          } else {
            setVoicePhase("idle", "Nothing recognized — try again");
          }
        } catch (err) {
          clearLiveBubble();
          if (sttProvider === "whisper") {
            if (shadowText) {
              setVoicePhase("idle");
              await onTranscript(shadowText);
              return;
            }
            setVoicePhase("idle", `Whisper failed: ${String(err.message || err).slice(0, 100)}`);
            return;
          }
          // Cloud STT failed (e.g. ElevenLabs quota exceeded) — permanently switch to Web Speech
          // for this session, and rescue the recording via shadowText or in-browser Whisper!
          const failedProvider = sttProvider;
          sttProviders = sttProviders.filter((p) => p !== failedProvider);
          preflightCache = { at: 0, stt: null, use: null, ok: false };
          prefs.stt = "browser";
          try { localStorage.setItem("startupVoicePrefs", JSON.stringify(prefs)); } catch { /* ignore */ }
          applySttProvider();
          if (shadowText) {
            setVoicePhase("idle", "Cloud STT quota → Web Speech");
            await onTranscript(shadowText);
            return;
          }
          setVoicePhase("idle", "Cloud STT quota exceeded → switched to Web Speech. Click Speak now.");
        }
      };
      mediaRecorder.start(250);
      watchRecordingMeter(mediaStream);
      // Live chat bubble while cloud/whisper records (final STT on Stop).
      paintSttPreview("");
      startInterimShadow();
      setStatus("Listening… · Stop to send");
    } catch (err) {
      stopMicCapture({ keepPhase: true });
      setVoicePhase("idle", `Microphone: ${String(err.message || err).slice(0, 100)}`);
    }
  }

  let browserStopRequested = false;

  function startBrowserListening() {
    if (voicePhase === "listening" && activeRecognition) {
      browserStopRequested = true;
      try { activeRecognition.stop(); } catch { /* ignore */ }
      return;
    }
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) {
      // Browser lacks SpeechRecognition (e.g. Firefox) -> fall back to Whisper MediaRecorder!
      prefs.stt = "whisper";
      applySttProvider();
      void startCloudListening();
      return;
    }
    stopSpeak();
    stopMicCapture({ keepPhase: true });
    browserStopRequested = false;
    const recognition = new Ctor();
    activeRecognition = recognition;
    recognition.lang = langTag(getLanguage());
    recognition.interimResults = true;
    // Continuous until Stop (#listenStopBtn / mic) — no silence auto-send.
    recognition.continuous = true;
    let finalText = "";
    // Enter "listening" immediately so the UI NEVER gets stuck on "Verarbeitet… (Abbrechen)"!
    setVoicePhase("listening", "Listening (Web Speech)… · Stop to send");
    paintSttPreview("");
    recognition.onstart = () => {
      if (activeRecognition === recognition) {
        setVoicePhase("listening", "Listening (Web Speech)… · Stop to send");
      }
    };
    recognition.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += `${t} `; else interim += t;
      }
      paintSttPreview(`${finalText}${interim}`);
    };
    recognition.onerror = (ev) => {
      const errCode = String(ev?.error || "");
      // Ignore benign 'no-speech' / 'aborted' while waiting for Stop.
      if ((errCode === "no-speech" || errCode === "aborted") && !browserStopRequested && voicePhase === "listening") {
        return;
      }
      if (activeRecognition === recognition) activeRecognition = null;
      stopWaveform();
      // If Web Speech failed because of network/service error (e.g. Brave/offline), fall back
      // to Whisper MediaRecorder automatically so STT ALWAYS works!
      if ((errCode === "network" || errCode === "service-not-allowed") && navigator.mediaDevices?.getUserMedia) {
        clearLiveBubble();
        prefs.stt = "whisper";
        applySttProvider();
        void startListening();
        return;
      }
      const rescued = takeLiveTranscript();
      if (rescued) {
        setVoicePhase("idle");
        void onTranscript(rescued);
        return;
      }
      clearLiveBubble();
      if (voicePhase === "listening" || voicePhase === "thinking") {
        setVoicePhase("idle", `Web Speech: ${errCode || "stopped"}`);
      }
    };
    recognition.onend = async () => {
      // Chrome stops SpeechRecognition on pauses even with continuous=true; if the user hasn't
      // pressed Stop yet, restart seamlessly and keep accumulating finalText!
      if (!browserStopRequested && voicePhase === "listening" && activeRecognition === recognition) {
        try {
          recognition.start();
          return;
        } catch {
          /* fall through and send what we have */
        }
      }
      if (activeRecognition === recognition) activeRecognition = null;
      stopWaveform();
      const t = takeLiveTranscript();
      setVoicePhase("idle");
      if (t) await onTranscript(t);
    };
    try {
      recognition.start();
      // Use synthetic waveform instead of opening a second getUserMedia audio stream,
      // which steals/resets the mic from SpeechRecognition on macOS Chrome/Safari!
      startSyntheticWaveform();
    } catch {
      activeRecognition = null;
      stopWaveform();
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
    // 1) Web Speech ("browser"): start SYNCHRONOUSLY without server preflight or "thinking" phase!
    //    (Awaiting fetch before recognition.start() loses the browser user-gesture activation
    //    and leaves the button stuck on "Verarbeitet… (Abbrechen)"!)
    if (sttProvider === "browser") {
      startBrowserListening();
      return;
    }
    // 2) Whisper (in-browser): MediaRecorder path, no server STT preflight.
    if (sttProvider === "whisper") {
      if (!navigator.mediaDevices?.getUserMedia) {
        sttProvider = "browser";
        onProviderChange();
        startBrowserListening();
        return;
      }
      try {
        const { modelManager } = await import("../../shared/model-manager.js");
        setVoicePhase("thinking", "Loading Whisper…");
        await modelManager.ensureLoaded("whisper");
      } catch (err) {
        // If Whisper fails to load, fall back immediately to Web Speech so STT still works!
        sttProvider = "browser";
        prefs.stt = "browser";
        applySttProvider();
        startBrowserListening();
        return;
      }
      await startCloudListening();
      return;
    }
    // 3) Cloud STT (ElevenLabs / Deepgram): short preflight with 3s timeout, fallback to Web Speech.
    setVoicePhase("thinking", "Checking STT…");
    try {
      const pf = await Promise.race([
        voicePreflight(sttProvider),
        new Promise((_, rej) => setTimeout(() => rej(new Error("preflight timeout")), 3000)),
      ]);
      const use = pf.use || "browser";
      if (use !== sttProvider && use !== "browser") {
        sttProvider = use;
        onProviderChange();
      }
      if (!pf.ok || use === "browser" || sttProvider === "browser") {
        sttProvider = "browser";
        onProviderChange();
        startBrowserListening();
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        sttProvider = "browser";
        startBrowserListening();
        return;
      }
      await startCloudListening();
    } catch {
      sttProvider = "browser";
      onProviderChange();
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
    // Cut TTS on mic click (never aborts background dossier extract).
    if (voicePhase === "speaking") {
      stopSpeak();
      clearAwaitingGreeting();
      setVoicePhase("idle");
      // One click: mute the agent and start dictating while extract continues.
      if (extractBusyInDock && canListen()) startListening();
      return;
    }
    if (voicePhase === "listening") {
      if (sttProvider === "elevenlabs" || sttProvider === "deepgram" || sttProvider === "whisper") {
        stopCloudRecording();
      } else if (activeRecognition) {
        browserStopRequested = true;
        try { activeRecognition.stop(); } catch { /* ignore */ }
      } else stopVoice();
      return;
    }
    if (voicePhase === "thinking") {
      if (confirmInterrupt && !confirmInterrupt()) return;
      stopVoice();
      return;
    }
    // Start listening immediately — NEVER abort an in-flight background dossier extract!
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
    setExtractBusy,
    syncMicLabels,
    setModeUi,
    // live-listening visuals, reused by the LiveKit driver (additive: not part of the driver contract)
    paintSttPreview,
    clearLiveBubble,
    startWaveform,
    startSyntheticWaveform,
    stopWaveform,
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
