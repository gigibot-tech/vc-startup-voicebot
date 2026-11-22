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
// After the whole reply was handed over, the worker must start talking within this long, else its
// voice is dead (it can fail without any error event) and the browser speaks the reply itself.
const VOICE_START_TIMEOUT_MS = 8000;
// Browser ears are half-duplex while the agent talks: an energy detector cannot tell the speakers'
// leak from the founder, and mistaking it for speech made the call flicker and cut replies off.
const SPEAK_TAIL_MS = 700;   // stay deaf this long after the agent stops (room echo)
const DEAF = 1e6;            // sensitivity multiplier that no sound can pass

/**
 * Whisper on silence / noise invents repeating text ("Ich bin gut, ich bin gut, ich bin gut ...").
 * True when some phrase of 1-6 words repeats back to back: 3x for single words, 2x for longer ones.
 * "ja ja ja" is dropped, "ja, genau" and ordinary sentences survive.
 */
export function looksHallucinated(raw) {
  const w = String(raw || "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  for (let p = 1; p <= 6; p += 1) {
    let run = 0;
    for (let i = p; i < w.length; i += 1) {
      run = w[i] === w[i - p] ? run + 1 : 0;
      if (run >= (p === 1 ? 3 : 2 * p)) return true;
    }
  }
  return false;
}

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
/** How the live call looks and reads. The pill and the button words tell the founder which of the
 *  two speak modes is running, and that the LiveKit voice agent (not the browser) is on the line.
 *  state: "idle" (mode selected, no call) | "connecting" (joining the room, waiting for the agent)
 *       | "live" (agent joined, mic open).
 *  `icon: "livekit"` makes voice.js draw the LiveKit mark in front of the text.
 *  `agent` (live only) = what the agent is doing, keyed by voice phase. */
const liveUi = (state) => {
  const live = state === "live";
  const connecting = state === "connecting";
  const pill = live
    ? {
      de: "LIVE · LiveKit-Agent", en: "LIVE · LiveKit agent", live: true, icon: "livekit",
      agent: {
        listening: { de: "hört zu", en: "listening" },
        thinking: { de: "denkt nach", en: "thinking" },
        speaking: { de: "spricht", en: "speaking" },
      },
    }
    : connecting
      ? { de: "LiveKit-Agent verbindet…", en: "Connecting LiveKit agent…", live: false, connecting: true, icon: "livekit" }
      : { de: "Live-Gespräch · LiveKit", en: "Live call · LiveKit", live: false, icon: "livekit" };
  return {
    pill,
    // While the call is live the classic voice must never report "idle" (see voice.js setVoicePhase).
    idleAs: live ? "listening" : null,
    labels: {
      idle: {
        de: "Live-Gespräch starten",
        en: "Start live call",
        titleDe: "Live-Gespräch starten: einfach reden, jederzeit unterbrechen",
        titleEn: "Start a hands-free call: just talk, interrupt any time",
      },
      // While joining the room the mic button used to read "Verarbeitet… (Abbrechen)" and did nothing.
      ...(connecting ? {
        thinking: {
          de: "Verbinde… (Abbrechen)",
          en: "Connecting… (Cancel)",
          titleDe: "Verbindung zum Sprach-Agenten abbrechen",
          titleEn: "Cancel connecting to the voice agent",
        },
      } : {}),
      // Never a classic label ("Verarbeitet…", "Sprechen") inside a call.
      ...(live ? {
        thinking: {
          de: "Denkt nach… (Abbrechen)",
          en: "Thinking… (Cancel)",
          titleDe: "Diese Antwort abbrechen – das Gespräch bleibt offen",
          titleEn: "Cancel this reply - the call stays open",
        },
      } : {}),
      listening: {
        de: "Auflegen",
        en: "Hang up",
        titleDe: "Gespräch beenden",
        titleEn: "End the call",
      },
      speaking: {
        de: "Unterbrechen",
        en: "Interrupt",
        titleDe: "Antwort überspringen (oder einfach reinreden)",
        titleEn: "Skip the reply (or just talk over it)",
      },
    },
    stop: { de: "Auflegen", en: "Hang up" },
  };
};

export function createLiveKitVoice({
  base, prefs, getLanguage, getSessionId, canListen, onTranscript, onAbort, confirmInterrupt,
  api, loadClient = loadLiveKit, readyTimeoutMs = READY_TIMEOUT_MS, browserStt = null, cues = null,
  voiceStartTimeoutMs = VOICE_START_TIMEOUT_MS, webSpeech = null, onUnavailable = null,
}) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const isDe = () => String(getLanguage?.() || "de").toLowerCase().startsWith("de");
  const tx = (de, en) => (isDe() ? de : en);

  let active = false;      // this driver is the selected mode
  let room = null;
  let connected = false;
  let connecting = false;
  /** Text of the reply being (or last) sent to the worker's voice, so a failing voice can be made up for. */
  let replyAcc = "";
  let replyForce = false;
  let workerTtsDown = false; // the worker's TTS gave up: speak through the classic driver for the rest of the call
  let attempt = 0;          // bumps on every connect() and every cancel: a stale connect() steps aside
  let callSessionId = null;
  let callLanguage = "";
  let sttName = "";
  let audioHost = null;
  let readyResolve = null;
  let localStt = false;     // this call transcribes in the browser (Whisper or Web Speech)
  let earsKind = "";        // "whisper" | "webspeech" while localStt
  let listener = null;
  let lkTrack = null;       // livekit-client Track enum (for the mic meter)
  let degraded = false;     // the worker's STT died: browser Whisper + browser voice carry the call
  let sttChain = Promise.resolve(); // utterances are transcribed one after another, in order
  let speakTailUntil = 0;   // the agent spoke until now: browser ears stay deaf a little longer
  let quietUntil = 0;       // a cue just played: speech detector stays deaf until then

  // Reply speech, one stream per turn. `out` remembers WHICH driver took the stream at begin(),
  // so a call that starts or ends mid-reply never splits one reply across two voices.
  let out = "classic";     // "classic" | "lk"
  let interrupted = false; // the founder cut this reply off: drop the rest of its stream
  let streamId = 0;
  let streamOn = false;
  let gate = null;
  let pending = "";
  let flushTimer = null;
  let startWatch = null;   // armed once a reply is fully handed to the worker voice
  /** Founder spoke while the reply was still being thought up: sent once the agent is done. */
  let queued = "";

  // ---------- low level -----------------------------------------------------------------

  const send = (msg) => {
    if (!room || !connected) return;
    room.localParticipant
      .publishData(enc.encode(JSON.stringify(msg)), { reliable: true, topic: TOPIC_CMD })
      .catch(() => { /* call is ending */ });
  };

  function disarmStartWatch() {
    if (startWatch) { clearTimeout(startWatch); startWatch = null; }
  }

  function armStartWatch() {
    disarmStartWatch();
    const id = streamId;
    startWatch = setTimeout(() => {
      startWatch = null;
      if (!connected || id !== streamId || workerTtsDown) return;
      onProviderError({ scope: "tts", message: tx("Die Stimme antwortet nicht.", "The voice is not responding.") });
    }, voiceStartTimeoutMs);
  }

  function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (!pending) return;
    send({ t: "speak_chunk", id: streamId, text: pending });
    pending = "";
  }

  /** The reply is being cut off: whatever is still waiting for the next batch must not go out. */
  /** Stop BOTH voices (the worker's and the browser's) and ignore the rest of this reply's stream. */
  function interruptSpeech() {
    interrupted = true;
    replyAcc = "";
    dropPending();
    send({ t: "speak_cancel" });
    base.stopSpeak();
  }

  function dropPending() {
    disarmStartWatch();
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

  /** Send what the founder said while the reply was being thought up (see handleTranscript). */
  function flushQueued() {
    if (!connected || !queued) return;
    const text = queued;
    queued = "";
    base.clearLiveBubble?.();
    void onTranscript(text);
  }

  function settle(status) {
    if (!connected) return;
    if (base.getPhase() !== "listening") cue("listen"); // your turn
    base.setVoicePhase("listening", status ?? tx("Ich höre zu…", "Listening…"));
    flushQueued();
  }

  function showError(message) {
    const text = String(message || "LiveKit error").slice(0, 160);
    // In a call, "idle" would read "Live-Gespräch starten" while the pill still says LIVE (it looked like
    // the call had failed). The call is still open: show the message and keep listening.
    if (connected) { settle(text); return; }
    base.setVoicePhase("idle", text);
  }

  function handleTranscript(raw) {
    const text = String(raw || "").trim();
    if (text.length < 2 || !connected || looksHallucinated(text)) { base.clearLiveBubble?.(); return; } // noise is not an answer
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
      interruptSpeech();
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

  /**
   * The worker's speech provider gave up (quota used up, bad key, outage).
   *  tts -> stay in the call and speak the replies with the browser's own voice (classic driver);
   *  stt -> the worker's session is gone too: carry on with browser Whisper + the browser voice
 *         (degradeToBrowser); hang up with a tip only when the browser cannot do STT.
   * Before this the call just sat on "Thinking…" / "Listening…" forever.
   */
  function onProviderError(ev) {
    const msg = String(ev.message || tx("Sprachdienst nicht erreichbar", "Voice service unavailable"));
    if (ev.scope === "tts" && connected) {
      const firstFailure = !workerTtsDown;
      workerTtsDown = true;
      base.setStatus(`${msg} ${tx("Ich antworte mit der Browser-Stimme.", "Replies use the browser voice.")}`);
      // The reply that was just sent to the dead voice would otherwise stay silent: say it here.
      // (not after the founder cut the reply off: the worker's error often arrives late)
      if (firstFailure && replyAcc.trim() && !interrupted) {
        const text = replyAcc;
        if (streamOn && out === "lk") {
          // Still streaming: hand the rest of this reply to the browser voice too.
          dropPending();
          send({ t: "speak_cancel" });
          out = "classic";
          base.beginSpeakStream({ force: replyForce });
          base.pushSpeakStream(text);
        } else {
          void base.speak(text, { force: replyForce });
        }
      }
      return;
    }
    if (ev.scope === "stt" && connected) {
      const giveUp = () => disconnect(`${msg} ${tx(
        "Tipp: Einstellungen → Spracherkennung → „Whisper (Browser)“ läuft ohne Server.",
        "Tip: Settings → speech recognition → “Whisper (Browser)” needs no server.",
      )}`);
      degradeToBrowser().then((ok) => { if (!ok) giveUp(); }).catch(giveUp);
      return;
    }
    showError(msg);
  }

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
          interruptSpeech();
          base.setVoicePhase("listening", tx("Ich höre zu…", "Listening…"));
        }
        break;
      case "agent_state":
        if (ev.state === "speaking") disarmStartWatch();
        if (ev.state === "speaking" && connected) base.setVoicePhase("speaking");
        break;
      case "transcript":
        handleTranscript(ev.text);
        break;
      case "speak_done":
        disarmStartWatch();
        // With the worker's voice down, the browser voice owns the "speaking" phase: do not flip it.
        if (workerTtsDown) break;
        if (ev.id === streamId) {
          if (ev.interrupted) dropPending();
          if (base.getPhase() === "speaking" || base.getPhase() === "listening") settle();
        }
        break;
      case "error":
        onProviderError(ev);
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

  /** Browser-side ears (local Whisper). The agent's own voice leaks into the mic: be pickier while it speaks. */
  function makeListener() {
    if (earsKind === "webspeech") return makeWebSpeechListener();
    return browserStt.createListener({
      onSpeechStart: onLocalSpeechStart,
      onUtterance: onLocalUtterance,
      getSensitivity: () => {
        const now = Date.now();
        if (base.getPhase() === "speaking") speakTailUntil = now + SPEAK_TAIL_MS;
        return now < Math.max(quietUntil, speakTailUntil) ? DEAF : 1;
      },
    });
  }

  /** Web Speech ears: results are ignored while the agent talks (or a cue just played). */
  function makeWebSpeechListener() {
    return webSpeech.create({
      lang: getLanguage(),
      onFinal: (text) => { if (connected) handleTranscript(text); },
      onInterim: (text) => {
        if (connected && base.getPhase() === "listening") base.paintSttPreview?.(text);
      },
      onError: (code) => { if (connected) showError(`Web Speech: ${code}`); },
      isPaused: () => base.getPhase() === "speaking" || Date.now() < quietUntil,
    });
  }

  /** Which ears this call uses, from Settings > speech recognition (never a surprise download). */
  function pickEars() {
    if (browserStt?.isEnabled()) return "whisper";
    if (webSpeech?.isEnabled()) return "webspeech";
    return "";
  }

  /**
   * The worker's speech-to-text died (quota, key, outage) and with it the worker's session, so it can
   * no longer listen OR speak. Keep the call going on the browser alone: Whisper in the browser for
   * ears, the classic voice for replies. Returns false when that is not possible (no browser STT).
   */
  async function degradeToBrowser() {
    if (degraded) return true;
    // A server provider died: prefer the browser's own recognizer (no download), else Whisper.
    const kind = webSpeech?.isSupported() ? "webspeech" : (browserStt ? "whisper" : "");
    if (!kind) return false;
    degraded = true;
    workerTtsDown = true;
    localStt = true;
    earsKind = kind;
    const name = kind === "webspeech" ? "Web Speech" : "Whisper";
    dropPending();
    base.setVoicePhase("thinking", tx(`Wechsle auf ${name} im Browser…`, `Switching to browser ${name}…`));
    try {
      if (kind === "whisper") await browserStt.prepare();
      if (!connected) return true;
      listener = makeListener();
      await listener.start();
      if (!connected) { try { listener.stop(); } catch { /* ok */ } listener = null; return true; }
      startMeter(room, lkTrack);
      settle(tx(
        `Server-Spracherkennung nicht verfügbar – jetzt ${name} im Browser. Bitte noch einmal sagen.`,
        `Server speech recognition unavailable - now browser ${name}. Please say that again.`,
      ));
      return true;
    } catch (err) {
      degraded = false;
      throw err;
    }
  }

  function cleanup() {
    if (active) base.setModeUi?.(liveUi("idle"));
    base.stopWaveform?.();
    base.clearLiveBubble?.();
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    disarmStartWatch();
    // Hanging up also silences the browser voice (replies spoken by the classic driver) and drops
    // the rest of the reply that chat.js is still streaming in.
    interrupted = true;
    replyAcc = "";
    base.stopSpeak();
    pending = "";
    streamOn = false;
    gate = null;
    queued = "";
    connected = false;
    connecting = false;
    workerTtsDown = false;
    degraded = false;
    readyResolve = null;
    try { listener?.stop(); } catch { /* already stopped */ }
    listener = null;
    localStt = false;
    earsKind = "";
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
    const mine = ++attempt;
    const stale = () => mine !== attempt;
    base.setModeUi?.(liveUi("connecting"));
    earsKind = pickEars();
    localStt = Boolean(earsKind);
    // Whisper is a big download / warm-up: start it NOW, while we join the room and wait for the
    // worker, instead of after them. Errors surface where it is awaited below.
    const whisperReady = earsKind === "whisper" ? browserStt.prepare() : null;
    whisperReady?.catch(() => {});
    base.stopSpeak();
    base.stopMicCapture({ keepPhase: true });
    base.setVoicePhase("thinking", tx("Verbinde mit LiveKit-Agent…", "Connecting to the LiveKit agent…"));
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
      lkTrack = Track;
      if (stale()) return;
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
        if (connected && !degraded && p.kind === ParticipantKind.AGENT) {
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
            "Sprach-Agent antwortet nicht – läuft der LiveKit-Worker? Ich bleibe bei „Antippen & sprechen“.",
            "Voice agent not responding – is the LiveKit worker running? Staying with “Tap & talk”.",
          ));
          err.explained = true; // already says what to do: no prefix
          reject(err);
        }, readyTimeoutMs);
      });
      // If connect() throws first, this promise rejects later with nobody awaiting it.
      ready.catch(() => {});
      await r.connect(join.url, join.token);
      if (stale()) { try { r.disconnect(); } catch { /* gone */ } return; }
      if (!localStt) await r.localParticipant.setMicrophoneEnabled(true);
      await r.startAudio().catch(() => { /* needs a click; we are inside one */ });
      await ready;
      if (stale()) return;

      if (localStt) {
        if (whisperReady) {
          base.setVoicePhase("thinking", tx("Lade Whisper…", "Loading Whisper…"));
          await whisperReady;
          if (stale()) return;
        }
        listener = makeListener();
        await listener.start();
        if (stale()) { try { listener.stop(); } catch { /* ok */ } listener = null; return; }
      }

      connected = true;
      connecting = false;
      base.setModeUi?.({ ...liveUi("live"), onIdle: flushQueued });
      startMeter(r, Track);
      callSessionId = sid;
      callLanguage = String(getLanguage()).slice(0, 2).toLowerCase();
      settle(tx("Live – ich höre zu", "Live – listening"));
      base.syncMicLabels();
    } catch (err) {
      if (stale()) return; // cancelled by the founder: cancelConnect() already cleaned up
      cleanup();
      const msg = String(err?.message || err);
      // The worker never answered: do not keep offering a mode that cannot work right now.
      if (err?.explained) onUnavailable?.(msg);
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

  /** [Verbinde… (Abbrechen)] while joining the room / waiting for the agent. */
  function cancelConnect() {
    attempt += 1;
    cleanup();
    base.setVoicePhase("idle", tx("Verbindung abgebrochen", "Connection cancelled"));
  }

  function onMicClick() {
    if (connecting) { cancelConnect(); return; }
    if (!connected) { void connect(); return; }
    const phase = base.getPhase();
    if (phase === "speaking") {
      // Skip the rest of the reply, stay in the call.
      interruptSpeech();
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
    interrupted = false;
    if (!connected || workerTtsDown) { out = "classic"; return base.beginSpeakStream({ force }); }
    out = "lk";
    replyAcc = "";
    replyForce = Boolean(force);
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
    if (interrupted) return undefined;
    if (out === "classic") return base.pushSpeakStream(chunk);
    if (!streamOn || !gate) return undefined;
    const safe = gate.push(chunk);
    replyAcc += safe;
    queueText(safe);
    return undefined;
  }

  function endSpeakStream(finalText) {
    if (interrupted) { interrupted = false; return undefined; }
    if (out === "classic") return base.endSpeakStream(finalText);
    if (!streamOn || !gate) {
      streamOn = false;
      if (connected) settle();
      return undefined;
    }
    const tail = gate.finish(finalText);
    replyAcc += tail;
    queueText(tail);
    flush();
    send({ t: "speak_end", id: streamId });
    armStartWatch();
    streamOn = false;
    gate = null;
    // Phase: the worker's agent_state flips it to "speaking"; if there was nothing to say it
    // never will, so do not leave the UI on "thinking".
    if (base.getPhase() === "thinking") base.setVoicePhase("speaking");
    return undefined;
  }

  /** One-shot text (greeting, "Weiter fragen"). */
  async function speak(text, opts = {}) {
    if (!connected || workerTtsDown) return base.speak(text, opts);
    const force = Boolean(opts.force);
    const clean = createGateFilter().finish(text);
    if (!clean || (!prefs.voice && !force)) { settle(); return undefined; }
    out = "lk";
    streamOn = false;
    replyAcc = clean;
    replyForce = force;
    streamId += 1;
    send({ t: "say", id: streamId, text: clean });
    armStartWatch();
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
    activate: () => { active = true; base.setModeUi?.(liveUi("idle")); },
    deactivate: () => { active = false; disconnect(); base.setModeUi?.(null); },
    onSessionChange,
    isConnected: () => connected,
  };
}
