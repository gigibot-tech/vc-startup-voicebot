/**
 * LiveKit voice driver: hands-free conversation instead of push-to-talk.
 *
 * Same public API as createVoice() in voice.js (see voice-mode.js), so chat.js / sessions /
 * proposals never know which mode runs. NOTHING here calls the LLM:
 *
 *   mic ─WebRTC─► worker (VAD + STT) ─"transcript"─► onTranscript(text) ─► chat.sendText()
 *                                                                           │ POST /turn/stream
 *   speaker ◄─WebRTC─ worker (TTS) ◄─"speak_*" pieces◄ push/endSpeakStream ◄─┘ (reply deltas)
 *
 * Without an open call every speech/mic method falls through to the classic driver (`base`),
 * e.g. the greeting is spoken by classic TTS before the founder presses [Sprechen].
 * Worker + wire protocol: features/voice/livekit_worker.py, livekit_protocol.py.
 */
import { createGateFilter } from "./speak-gate.js";

const LIVEKIT_CLIENT = "https://cdn.jsdelivr.net/npm/livekit-client@2.24.1/+esm";
const TOPIC_CMD = "sv.cmd";
const TOPIC_EVT = "sv.evt";
const READY_TIMEOUT_MS = 15000;
const FLUSH_MS = 60;

let lkModule = null;
const loadLiveKit = () => (lkModule ??= import(LIVEKIT_CLIENT));

/**
 * @param {object} deps
 * @param {object} deps.base          classic driver (UI phase/labels + everything outside a call)
 * @param {object} deps.prefs
 * @param {() => string} deps.getLanguage
 * @param {() => string|null} deps.getSessionId
 * @param {() => boolean} deps.canListen
 * @param {(text: string) => unknown} deps.onTranscript   -> chat.sendText
 * @param {() => void} deps.onAbort                        -> chat.abortTurn
 * @param {() => boolean} [deps.confirmInterrupt]
 * @param {Function} deps.api              JSON fetch wrapper (shared/api.js; injected so node tests can fake it)
 * @param {Function} [deps.loadClient]     resolves the livekit-client module (tests inject a fake)
 * @param {{play(name: string): number}} [deps.cues]  audio cues (cues.js): listen / heard / end
 * @param {number} [deps.readyTimeoutMs]   how long to wait for the worker to join the room
 * @param {object} [deps.browserStt]       local Whisper in the browser (browser-listen.js):
 *   {isEnabled(): boolean, prepare(): Promise, createListener(handlers): {start, stop},
 *    transcribe(samples, sampleRate, language): Promise<string>}. When enabled, the worker only
 *   speaks and the mic never leaves the browser.
 */
export function createLiveKitVoice({
  base, prefs, getLanguage, getSessionId, canListen, onTranscript, onAbort, confirmInterrupt,
  api, loadClient = loadLiveKit, readyTimeoutMs = READY_TIMEOUT_MS, browserStt = null, cues = null,
}) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const isDe = () => String(getLanguage?.() || "de").toLowerCase().startsWith("de");
  const tx = (de, en) => (isDe() ? de : en);

  let active = false;      // this driver is the selected mode
  let room = null;
  let connected = false;
  let connecting = false;
  let callSessionId = null;
  let callLanguage = "";
  let sttName = "";
  let audioHost = null;
  let readyResolve = null;
  let localStt = false;     // this call transcribes in the browser
  let listener = null;
  let sttChain = Promise.resolve(); // utterances are transcribed one after another, in order
  let quietUntil = 0;       // a cue just played: speech detector stays deaf until then

  // Reply speech, one stream per turn. `out` remembers WHICH driver took the stream at begin(),
  // so a call that starts or ends mid-reply never splits one reply across two voices.
  let out = "classic";     // "classic" | "lk"
  let streamId = 0;
  let streamOn = false;
  let gate = null;
  let pending = "";
  let flushTimer = null;
  /** Founder spoke while the reply was still being thought up: sent once the agent is done. */
  let queued = "";

  // ---------- low level -----------------------------------------------------------------

  const send = (msg) => {
    if (!room || !connected) return;
    room.localParticipant
      .publishData(enc.encode(JSON.stringify(msg)), { reliable: true, topic: TOPIC_CMD })
      .catch(() => { /* call is ending */ });
  };

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending) return;
    send({ t: "speak_chunk", id: streamId, text: pending });
    pending = "";
  }

  /** The reply is being cut off: whatever is still waiting for the next batch must not go out. */
  function dropPending() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    pending = "";
    streamOn = false;
  }

  function queueText(text) {
    if (!text) return;
    pending += text;
    if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  /** Back to "mic open, nobody talking" and send what the founder said in the meantime. */
  /** Play a cue and keep our own speech detector from mistaking it for the founder. */
  function cue(name) {
    const ms = cues?.play(name) || 0;
    if (ms) quietUntil = Date.now() + ms + 400;
  }

  function settle(status) {
    if (!connected) return;
    if (base.getPhase() !== "listening") cue("listen"); // your turn
    base.setVoicePhase("listening", status ?? tx("Ich höre zu…", "Listening…"));
    if (queued) {
      const text = queued;
      queued = "";
      base.clearLiveBubble?.();
      void onTranscript(text);
    }
  }

  function showError(message) {
    base.setVoicePhase("idle", String(message || "LiveKit error").slice(0, 160));
  }

  function handleTranscript(raw) {
    const text = String(raw || "").trim();
    if (text.length < 2 || !connected) { base.clearLiveBubble?.(); return; } // noise is not an answer
    cue("heard");
    if (base.getPhase() === "thinking") {
      // A turn is in flight and chat.sendText() would drop this: hold it until the agent is done,
      // but keep it visible as a pending bubble so the founder sees it was heard.
      queued = queued ? `${queued} ${text}` : text;
      base.paintSttPreview?.(queued);
      base.setStatus(tx("Wird nach der Antwort gesendet…", "Sending after the reply…"));
    } else {
      base.clearLiveBubble?.(); // sendText() paints the real "Du" bubble
      void onTranscript(text);
    }
  }

  /** Browser-side ears: the founder started talking. Same effect as the worker's barge-in. */
  function onLocalSpeechStart() {
    if (!connected) return;
    if (base.getPhase() === "speaking") {
      dropPending();
      send({ t: "speak_cancel" });
      base.setVoicePhase("listening", tx("Ich höre zu…", "Listening…"));
    } else if (base.getPhase() === "listening") {
      base.setStatus(tx("Ich höre zu…", "Listening…"));
      base.paintSttPreview?.(""); // waiting bubble: "…" while the founder talks (no live words with Whisper)
    }
  }

  function onLocalUtterance(samples, rate) {
    const lang = String(getLanguage()).slice(0, 2).toLowerCase();
    const wasListening = base.getPhase() === "listening";
    if (wasListening) {
      base.setStatus(tx("Transkribiere…", "Transcribing…"));
      base.paintSttPreview?.(tx("Transkribiere…", "Transcribing…"));
    }
    sttChain = sttChain
      .then(() => browserStt.transcribe(samples, rate, lang))
      .then((text) => { if (connected) handleTranscript(text); })
      .catch((err) => { if (connected) showError(`Whisper: ${err?.message || err}`); });
  }

  // ---------- worker events -------------------------------------------------------------

  function onWorkerEvent(ev) {
    switch (ev.t) {
      case "ready":
        sttName = ev.stt || "";
        callLanguage = String(ev.language || callLanguage);
        readyResolve?.();
        break;
      case "interim":
        // Live words in a chat bubble (same as classic), only while we are the one listening.
        if (connected && base.getPhase() === "listening") base.paintSttPreview?.(String(ev.text || ""));
        break;
      case "user_state":
        // Founder started talking over the agent: classic mic-click behaviour, hands-free.
        if (ev.state === "speaking" && base.getPhase() === "speaking") {
          dropPending();
          base.setVoicePhase("listening", tx("Ich höre zu…", "Listening…"));
        }
        break;
      case "agent_state":
        if (ev.state === "speaking" && connected) base.setVoicePhase("speaking");
        break;
      case "transcript":
        handleTranscript(ev.text);
        break;
      case "speak_done":
        if (ev.id === streamId) {
          if (ev.interrupted) dropPending();
          if (base.getPhase() === "speaking" || base.getPhase() === "listening") settle();
        }
        break;
      case "error":
        showError(ev.message);
        break;
      default:
        break;
    }
  }

  // ---------- call lifecycle ------------------------------------------------------------

  function attachAudio(track) {
    if (!audioHost) {
      audioHost = document.createElement("div");
      audioHost.hidden = true;
      document.body.appendChild(audioHost);
    }
    audioHost.appendChild(track.attach());
  }

  /** Wave + orb react to the founder's mic whenever the call is open, so "I'm listening" is obvious. */
  function startMeter(r, Track) {
    try {
      const stream = listener?.getStream?.()
        || (() => {
          const track = r.localParticipant.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack;
          return track ? new MediaStream([track]) : null;
        })();
      if (stream) base.startWaveform?.(stream);
      else base.startSyntheticWaveform?.();
    } catch {
      base.startSyntheticWaveform?.();
    }
  }

  function cleanup() {
    base.stopWaveform?.();
    base.clearLiveBubble?.();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    pending = "";
    streamOn = false;
    gate = null;
    queued = "";
    connected = false;
    connecting = false;
    readyResolve = null;
    try { listener?.stop(); } catch { /* already stopped */ }
    listener = null;
    localStt = false;
    sttChain = Promise.resolve();
    const r = room;
    room = null;
    callSessionId = null;
    try { r?.disconnect(); } catch { /* already gone */ }
    audioHost?.remove();
    audioHost = null;
  }

  async function connect() {
    if (connected || connecting) return;
    const sid = getSessionId();
    if (!canListen() || !sid) return;
    connecting = true;
    localStt = Boolean(browserStt?.isEnabled());
    base.stopSpeak();
    base.stopMicCapture({ keepPhase: true });
    base.setVoicePhase("thinking", tx("Verbinde…", "Connecting…"));
    try {
      const join = await api("/api/voice/join", {
        method: "POST",
        body: JSON.stringify({
          mode: "livekit",
          session_id: sid,
          language: getLanguage(),
          voice: { stability: prefs.stability, similarity: prefs.similarity, speed: prefs.speed },
          stt: localStt ? "browser" : "server",
        }),
      });
      const { Room, RoomEvent, Track, ParticipantKind } = await loadClient();
      const r = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      room = r;
      r.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) attachAudio(track);
      });
      r.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        if (topic !== TOPIC_EVT) return;
        try { onWorkerEvent(JSON.parse(dec.decode(payload))); } catch { /* malformed packet */ }
      });
      r.on(RoomEvent.ParticipantDisconnected, (p) => {
        if (connected && p.kind === ParticipantKind.AGENT) {
          disconnect(tx("Sprach-Agent beendet", "Voice agent left"));
        }
      });
      r.on(RoomEvent.Disconnected, () => {
        if (connected) disconnect(tx("Verbindung getrennt", "Disconnected"));
      });

      const ready = new Promise((resolve, reject) => {
        readyResolve = resolve;
        setTimeout(() => {
          const err = new Error(tx(
            "Sprach-Agent antwortet nicht – läuft der LiveKit-Worker? (siehe README)",
            "Voice agent not responding – is the LiveKit worker running? (see README)",
          ));
          err.explained = true; // already says what to do: no prefix
          reject(err);
        }, readyTimeoutMs);
      });
      // If connect() throws first, this promise rejects later with nobody awaiting it.
      ready.catch(() => {});
      await r.connect(join.url, join.token);
      if (!localStt) await r.localParticipant.setMicrophoneEnabled(true);
      await r.startAudio().catch(() => { /* needs a click; we are inside one */ });
      await ready;

      if (localStt) {
        base.setVoicePhase("thinking", tx("Lade Whisper…", "Loading Whisper…"));
        await browserStt.prepare();
        listener = browserStt.createListener({
          onSpeechStart: onLocalSpeechStart,
          onUtterance: onLocalUtterance,
          // The agent's own voice leaks into the mic: be pickier while it speaks.
          getSensitivity: () => (base.getPhase() === "speaking" || Date.now() < quietUntil ? 2.2 : 1),
        });
        await listener.start();
      }

      connected = true;
      connecting = false;
      startMeter(r, Track);
      callSessionId = sid;
      callLanguage = String(getLanguage()).slice(0, 2).toLowerCase();
      settle(tx("Live – ich höre zu", "Live – listening"));
      base.syncMicLabels();
    } catch (err) {
      cleanup();
      const msg = String(err?.message || err);
      showError(err?.explained ? msg : `${tx("LiveKit-Verbindung fehlgeschlagen: ", "LiveKit connection failed: ")}${msg}`);
    }
  }

  function disconnect(reason) {
    const was = connected || connecting;
    const wasLive = connected;
    cleanup();
    if (wasLive) cue("end");
    if (was) base.setVoicePhase("idle", reason || tx("Gespräch beendet", "Call ended"));
  }

  // ---------- the classic voice API -----------------------------------------------------

  function onMicClick() {
    if (connecting) return;
    if (!connected) { void connect(); return; }
    const phase = base.getPhase();
    if (phase === "speaking") {
      // Skip the rest of the reply, stay in the call.
      dropPending();
      send({ t: "speak_cancel" });
      settle();
      return;
    }
    if (phase === "thinking") {
      if (confirmInterrupt && !confirmInterrupt()) return;
      queued = "";
      onAbort();
      settle();
      return;
    }
    disconnect();
  }

  function beginSpeakStream({ force = false } = {}) {
    if (!connected) { out = "classic"; return base.beginSpeakStream({ force }); }
    out = "lk";
    flush();
    send({ t: "speak_cancel" });
    streamOn = Boolean(prefs.voice || force);
    gate = createGateFilter();
    if (streamOn) {
      streamId += 1;
      send({ t: "speak_begin", id: streamId });
    }
    return undefined;
  }

  function pushSpeakStream(chunk) {
    if (out === "classic") return base.pushSpeakStream(chunk);
    if (!streamOn || !gate) return undefined;
    queueText(gate.push(chunk));
    return undefined;
  }

  function endSpeakStream(finalText) {
    if (out === "classic") return base.endSpeakStream(finalText);
    if (!streamOn || !gate) {
      streamOn = false;
      if (connected) settle();
      return undefined;
    }
    queueText(gate.finish(finalText));
    flush();
    send({ t: "speak_end", id: streamId });
    streamOn = false;
    gate = null;
    // Phase: the worker's agent_state flips it to "speaking"; if there was nothing to say it
    // never will, so do not leave the UI on "thinking".
    if (base.getPhase() === "thinking") base.setVoicePhase("speaking");
    return undefined;
  }

  /** One-shot text (greeting, "Weiter fragen"). */
  async function speak(text, opts = {}) {
    if (!connected) return base.speak(text, opts);
    const force = Boolean(opts.force);
    const clean = createGateFilter().finish(text);
    if (!clean || (!prefs.voice && !force)) { settle(); return undefined; }
    out = "lk";
    streamOn = false;
    streamId += 1;
    send({ t: "say", id: streamId, text: clean });
    base.setVoicePhase("speaking");
    return undefined;
  }

  function stopSpeak() {
    base.stopSpeak();
    if (connected) {
      dropPending();
      send({ t: "speak_cancel" });
    }
  }

  function stopMicCapture(opts) {
    // The call keeps the mic open on purpose: chat.js calls this at the start of EVERY turn.
    if (connected || connecting) return;
    base.stopMicCapture(opts);
  }

  function setVoicePhase(phase, text) {
    // In a call "idle" means "mic open, agent quiet" = listening.
    if (connected && phase === "idle") { settle(text); return; }
    base.setVoicePhase(phase, text);
  }

  function onSessionChange() {
    if (!connected) return;
    if (getSessionId() !== callSessionId) { disconnect(tx("Gespräch gewechselt", "Switched conversation")); return; }
    const lang = String(getLanguage()).slice(0, 2).toLowerCase();
    if (lang && lang !== callLanguage) {
      callLanguage = lang;
      send({ t: "config", language: lang });
    }
  }

  // Classic's "Stopp" button lives in voice.js and knows nothing about calls: while this driver is
  // selected, intercept it first (capture phase) so it ends the call instead.
  document.addEventListener("click", (e) => {
    if (!active || !e.target?.closest?.("#listenStopBtn")) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    onMicClick();
  }, true);

  return {
    // --- call-aware
    onMicClick,
    beginSpeakStream,
    pushSpeakStream,
    endSpeakStream,
    speak,
    stopSpeak,
    stopMicCapture,
    setVoicePhase,
    sttLabel: () => (connected
      ? `LiveKit${localStt ? " · Whisper (Browser)" : sttName ? ` · ${sttName}` : ""}`
      : "LiveKit"),
    // --- unchanged: UI helpers and the classic STT plumbing
    getPhase: () => base.getPhase(),
    setStatus: (s) => base.setStatus(s),
    setExtractBusy: (b) => base.setExtractBusy(b),
    syncMicLabels: () => base.syncMicLabels(),
    resolveSttProvider: () => base.resolveSttProvider(),
    applySttProvider: () => base.applySttProvider(),
    setProviders: (l) => base.setProviders(l),
    useBrowser: () => base.useBrowser(),
    // --- mode switch hooks (voice-mode.js)
    activate: () => { active = true; },
    deactivate: () => { active = false; disconnect(); },
    onSessionChange,
    isConnected: () => connected,
  };
}
