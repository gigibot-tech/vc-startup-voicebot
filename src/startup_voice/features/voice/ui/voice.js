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
 * KNOWN LIMIT
 * -----------
 * speak() is called only AFTER the whole reply has streamed in, and /api/tts
 * returns one complete mp3. The text streams; the voice does not.
 */
import { api } from "../../shared/api.js";
import { clampSpeed, langTag } from "../../shared/format.js";

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
 * @param {HTMLInputElement} deps.textInput  shows interim browser-STT text
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
 */
export function createVoice({ prefs, textInput, canListen, getLanguage, onTranscript, onProviderChange, onAbort }) {
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

  const setStatus = (s) => {
    voiceStatus.textContent = s;
    if (voiceStatusTop) voiceStatusTop.textContent = s;
  };
  const micButtons = () => [document.getElementById("micBtn")].filter(Boolean);
  const syncMicLabels = () => {
    let label = "Sprechen";
    let title = "Antwort einsprechen";
    let live = false;
    let thinking = false;
    let speaking = false;
    if (voicePhase === "listening") {
      label = "Stoppen";
      title = "Aufnahme beenden und senden";
      live = true;
    } else if (voicePhase === "speaking") {
      label = "Stopp Stimme";
      title = "Agent-Stimme stoppen";
      speaking = true;
    } else if (voicePhase === "thinking") {
      label = "Abbrechen";
      title = "Verarbeitung abbrechen";
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
    else if (phase === "idle") setStatus("Bereit");
    else if (phase === "listening") setStatus("Hört zu…");
    else if (phase === "thinking") setStatus("Denkt…");
    else if (phase === "speaking") setStatus("Spricht…");
  };
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

  function stopMicCapture({ keepPhase } = {}) {
    clearSilenceWatch();
    speechSeen = false;
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
    if (!audioEl) return;
    const el = audioEl;
    audioEl = null;
    el.onended = null;
    el.onerror = null;
    try { el.pause(); } catch { /* ignore */ }
    el.removeAttribute("src");
    try { el.load(); } catch { /* ignore */ }
  }

  function afterSpeak() {
    if (voicePhase === "speaking") setVoicePhase("idle");
    if (prefs.auto && canListen()) startListening();
  }

  /**
   * TEXT → VOICE. Plays `text` aloud via POST /api/tts (ElevenLabs → one mp3).
   * Called by the HOST (chat.js sendText) AFTER the LLM reply has fully arrived.
   * It does not generate the text; it only reads out what it is given.
   */
  async function speak(text) {
    stopSpeak();
    if (!prefs.voice || !text) {
      setVoicePhase("idle");
      return;
    }
    setVoicePhase("speaking");
    try {
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
      const url = URL.createObjectURL(await res.blob());
      audioEl = new Audio(url);
      audioEl.playbackRate = 1;
      audioEl.onended = () => {
        URL.revokeObjectURL(url);
        if (audioEl) audioEl = null;
        afterSpeak();
      };
      audioEl.onerror = () => {
        URL.revokeObjectURL(url);
        audioEl = null;
        setVoicePhase("idle", "TTS fehlgeschlagen");
      };
      await audioEl.play();
    } catch (err) {
      let msg = String(err.message || err);
      try { msg = JSON.parse(msg).detail || msg; } catch { /* plain */ }
      setVoicePhase("idle", `TTS fehlgeschlagen — ${String(msg).slice(0, 120)}`);
    }
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
        setVoicePhase("idle", "Mikrofonfehler");
      };
      mediaRecorder.onstop = async () => {
        clearSilenceWatch();
        const blob = new Blob(mediaChunks, { type: mediaRecorder?.mimeType || "audio/webm" });
        if (mediaStream) {
          mediaStream.getTracks().forEach((t) => t.stop());
          mediaStream = null;
        }
        mediaRecorder = null;
        mediaChunks = [];
        if (!blob.size) {
          setVoicePhase("idle", "Nichts gehört");
          return;
        }
        setVoicePhase("thinking", `Transkribiert (${sttLabel()})…`);
        try {
          const text = await transcribeCloud(blob);
          if (text) {
            textInput.value = "";
            // ── HAND-OFF (cloud STT path) ─────────────────────────────────────
            // voice.js ends here. The host decides what a transcript means;
            // in this app that is sendText() → POST .../turn/stream → LLM.
            await onTranscript(text);
          } else {
            setVoicePhase("idle", "Nichts erkannt — bitte nochmal");
          }
        } catch (err) {
          // Cloud STT failed after record — fall back to browser for next attempt.
          preflightCache = { at: 0, stt: null, use: null, ok: false };
          sttProvider = "browser";
          onProviderChange();
          setVoicePhase("idle", `Cloud-STT down → Web Speech. Nochmal Sprechen.`);
        }
      };
      mediaRecorder.start(250);
      watchSilence(mediaStream);
      setStatus("Hört zu… (Stoppen = senden)");
    } catch (err) {
      stopMicCapture({ keepPhase: true });
      setVoicePhase("idle", `Mikrofon: ${String(err.message || err).slice(0, 100)}`);
    }
  }

  function startBrowserListening() {
    if (voicePhase === "listening" && activeRecognition) {
      try { activeRecognition.stop(); } catch { /* ignore */ }
      return;
    }
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) { setVoicePhase("idle", "Mikrofon nicht verfügbar — bitte tippen"); return; }
    stopSpeak();
    stopMicCapture({ keepPhase: true });
    const recognition = new Ctor();
    activeRecognition = recognition;
    recognition.lang = langTag(getLanguage());
    recognition.interimResults = true;
    recognition.continuous = false;
    let finalText = "";
    recognition.onstart = () => setVoicePhase("listening");
    recognition.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalText += `${t} `; else interim += t;
      }
      textInput.value = (finalText || interim).trim();
    };
    recognition.onerror = () => {
      if (activeRecognition === recognition) activeRecognition = null;
      if (voicePhase === "listening") setVoicePhase("idle");
    };
    recognition.onend = async () => {
      if (activeRecognition === recognition) activeRecognition = null;
      if (voicePhase !== "listening") return;
      const t = textInput.value.trim();
      textInput.value = "";
      // ── HAND-OFF (browser Web Speech path) ──────────────────────────────
      // Same contract as the cloud path above: pass the string out, stop here.
      if (t) await onTranscript(t);
      else setVoicePhase("idle");
    };
    try { recognition.start(); }
    catch {
      activeRecognition = null;
      setVoicePhase("idle", "Mikrofon beschäftigt");
    }
  }

  async function startListening() {
    if (!canListen()) { setStatus("Zuerst Gespräch wählen"); return; }
    // Sprechen: kill TTS first — never start mic while agent still talks.
    stopSpeak();
    stopMicCapture({ keepPhase: true });
    sttProvider = resolveSttProvider();
    setVoicePhase("thinking", "Prüfe STT…");
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
          setStatus("Cloud-STT unreachable → Web Speech");
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
      setVoicePhase("idle", `STT-Check fail → Web Speech (${String(err.message || err).slice(0, 80)})`);
      startBrowserListening();
    }
  }

  const stopVoice = () => {
    stopSpeak();
    stopMicCapture({ keepPhase: true });
    onAbort();
    setVoicePhase("idle");
  };

  const onMicClick = () => {
    // Always cut TTS on mic interaction — Sprechen must not wait on speak().
    if (voicePhase === "speaking") stopSpeak();
    if (voicePhase === "listening") {
      if (sttProvider === "elevenlabs" || sttProvider === "deepgram") stopCloudRecording();
      else if (activeRecognition) { try { activeRecognition.stop(); } catch { /* ignore */ } }
      else stopVoice();
      return;
    }
    if (voicePhase === "thinking") {
      stopVoice();
      return;
    }
    startListening();
  };

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
    onMicClick,
  };
}
