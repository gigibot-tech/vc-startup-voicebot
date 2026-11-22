// Run: node --test tests/js/*.test.mjs   (pytest runs it too when `node` is installed)
// Drives voice-livekit.js and voice-mode.js with a fake classic driver and a fake livekit-client.
import assert from "node:assert/strict";
import test from "node:test";

// Minimal browser surface the driver touches.
const clickListeners = [];
globalThis.document = {
  addEventListener: (type, fn, capture) => clickListeners.push({ type, fn, capture }),
  createElement: () => ({ appendChild() {}, remove() {}, hidden: false }),
  body: { appendChild() {} },
};

globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks; } };
const { createLiveKitVoice } = await import("../../src/startup_voice/features/voice/ui/voice-livekit.js");
const { createVoiceSwitch, METHODS } = await import("../../src/startup_voice/features/voice/ui/voice-mode.js");

// ---------- fakes -------------------------------------------------------------------------

function fakeBase() {
  const calls = [];
  let phase = "idle";
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return ret; };
  const base = {
    calls,
    getPhase: () => phase,
    setVoicePhase: (p, text) => { phase = p; calls.push(["setVoicePhase", p, text]); },
    setStatus: rec("setStatus"),
    setExtractBusy: rec("setExtractBusy"),
    syncMicLabels: rec("syncMicLabels"),
    sttLabel: () => "classic-stt",
    resolveSttProvider: rec("resolveSttProvider", "browser"),
    applySttProvider: rec("applySttProvider"),
    setProviders: rec("setProviders"),
    useBrowser: rec("useBrowser"),
    stopMicCapture: rec("stopMicCapture"),
    stopSpeak: rec("stopSpeak"),
    speak: rec("speak"),
    beginSpeakStream: rec("beginSpeakStream"),
    pushSpeakStream: rec("pushSpeakStream"),
    endSpeakStream: rec("endSpeakStream"),
    onMicClick: rec("onMicClick"),
    paintSttPreview: rec("paintSttPreview"),
    clearLiveBubble: rec("clearLiveBubble"),
    startWaveform: rec("startWaveform"),
    startSyntheticWaveform: rec("startSyntheticWaveform"),
    stopWaveform: rec("stopWaveform"),
    setModeUi: rec("setModeUi"),
  };
  return base;
}

/** Stands in for livekit-client: records published commands, lets the test inject worker events. */
function fakeLiveKit({ autoReady = true } = {}) {
  const sent = [];
  const handlers = {};
  const state = { room: null, disconnected: 0 };
  const RoomEvent = { TrackSubscribed: "ts", DataReceived: "dr", ParticipantDisconnected: "pd", Disconnected: "d" };
  class Room {
    constructor() { state.room = this; this.localParticipant = {
      setMicrophoneEnabled: async () => {},
      getTrackPublication: () => ({ track: { mediaStreamTrack: { id: "mic" } } }),
      publishData: async (bytes, opts) => { sent.push({ ...JSON.parse(new TextDecoder().decode(bytes)), topic: opts.topic }); },
    }; }
    on(ev, fn) { handlers[ev] = fn; }
    async connect() { if (autoReady) queueMicrotask(() => emit({ t: "ready", stt: "deepgram", language: "de" })); }
    async startAudio() {}
    disconnect() { state.disconnected += 1; }
  }
  const emit = (msg) => handlers[RoomEvent.DataReceived](
    new TextEncoder().encode(JSON.stringify(msg)), null, 0, "sv.evt",
  );
  return {
    sent, emit, state, handlers,
    client: { Room, RoomEvent, Track: { Kind: { Audio: "audio" }, Source: { Microphone: "microphone" } }, ParticipantKind: { AGENT: 4 } },
  };
}

function setup({ lk = fakeLiveKit(), sessionId = "s1", prefs = {}, readyTimeoutMs = 200, browserStt = null, cues = null, voiceStartTimeoutMs = 8000, webSpeech = null } = {}) {
  const base = fakeBase();
  const transcripts = [];
  const aborts = [];
  const ctx = { sessionId, language: "de-DE", canListen: true };
  const joins = [];
  const voice = createLiveKitVoice({
    base,
    prefs: { voice: true, stability: 0.5, similarity: 0.7, speed: 1, ...prefs },
    getLanguage: () => ctx.language,
    getSessionId: () => ctx.sessionId,
    canListen: () => ctx.canListen,
    onTranscript: (t) => transcripts.push(t),
    onAbort: () => aborts.push(1),
    api: async (path, opts) => { joins.push({ path, body: JSON.parse(opts.body) }); return { url: "ws://x", token: "tok" }; },
    loadClient: async () => lk.client,
    readyTimeoutMs,
    browserStt,
    cues,
    voiceStartTimeoutMs,
    webSpeech,
  });
  return { voice, base, lk, transcripts, aborts, ctx, joins };
}

const flush = () => new Promise((r) => setTimeout(r, 90)); // > the driver's 60 ms batching
const phases = (base) => base.calls.filter((c) => c[0] === "setVoicePhase").map((c) => c[1]);
const cmds = (lk) => lk.sent.map(({ topic, ...m }) => m);

async function connected(opts) {
  const t = setup(opts);
  t.voice.onMicClick();
  await flush();
  return t;
}

// ---------- the switch --------------------------------------------------------------------

test("switch refuses a driver that lacks part of the voice API", () => {
  const partial = Object.fromEntries(METHODS.slice(1).map((m) => [m, () => {}]));
  assert.throws(() => createVoiceSwitch({ drivers: { classic: partial }, getPreferred: () => "" }), /lacks: getPhase/);
});

test("switch falls back to classic until the server says a mode is available", () => {
  const log = [];
  const mk = (name) => ({
    ...Object.fromEntries(METHODS.map((m) => [m, (...a) => { log.push([name, m, ...a]); return name; }])),
    activate: () => log.push([name, "activate"]),
    deactivate: () => log.push([name, "deactivate"]),
  });
  let preferred = "livekit";
  const sw = createVoiceSwitch({ drivers: { classic: mk("classic"), livekit: mk("livekit") }, getPreferred: () => preferred });

  assert.equal(sw.getMode(), "classic");
  assert.equal(sw.speak("hi"), "classic");

  sw.setAvailableModes(["livekit"]);
  assert.equal(sw.getMode(), "livekit");
  assert.equal(sw.speak("hi"), "livekit");
  assert.deepEqual(log.filter((e) => e[1] === "activate" || e[1] === "deactivate"), [
    ["classic", "deactivate"], ["livekit", "activate"],
  ]);

  preferred = "classic";
  sw.refresh();
  assert.equal(sw.getMode(), "classic");
  assert.deepEqual(log.at(-2).slice(0, 2), ["livekit", "deactivate"]);
});

test("switch follows the server default while the user has no preference", () => {
  const mk = () => Object.fromEntries(METHODS.map((m) => [m, () => {}]));
  const sw = createVoiceSwitch({
    drivers: { classic: mk(), livekit: mk() }, getPreferred: () => "", getServerDefault: () => "livekit",
  });
  sw.setAvailableModes(["classic", "livekit"]);
  assert.equal(sw.getMode(), "livekit");
  assert.equal(sw.isAvailable("livekit"), true);
});

// ---------- connecting --------------------------------------------------------------------

test("mic click joins a room for this session and goes live once the worker is ready", async () => {
  const { voice, base, joins } = await connected();
  assert.deepEqual(joins[0], {
    path: "/api/voice/join",
    body: { mode: "livekit", session_id: "s1", language: "de-DE", voice: { stability: 0.5, similarity: 0.7, speed: 1 }, stt: "server" },
  });
  assert.equal(voice.isConnected(), true);
  assert.equal(base.getPhase(), "listening");
  assert.equal(voice.sttLabel(), "LiveKit · deepgram");
});

test("a worker that never shows up fails cleanly with a hint, and nothing stays connected", async () => {
  const { voice, base, lk } = setup({ lk: fakeLiveKit({ autoReady: false }), readyTimeoutMs: 30 });
  voice.onMicClick();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(voice.isConnected(), false);
  assert.equal(base.getPhase(), "idle");
  const last = base.calls.filter((c) => c[0] === "setVoicePhase").at(-1);
  assert.match(last[2], /worker/i);
  assert.equal(lk.state.disconnected, 1);
});

test("no join without an open session", async () => {
  const t = setup();
  t.ctx.canListen = false;
  t.voice.onMicClick();
  await flush();
  assert.equal(t.joins.length, 0);
});

// ---------- listening ---------------------------------------------------------------------

test("a finished utterance goes to the normal sendText path", async () => {
  const { voice, lk, transcripts } = await connected();
  lk.emit({ t: "transcript", text: "Wir sind zwei Gründer" });
  assert.deepEqual(transcripts, ["Wir sind zwei Gründer"]);
  assert.equal(voice.isConnected(), true);
});

test("words said while the reply is still being thought up are sent after the agent is done", async () => {
  const { voice, base, lk, transcripts } = await connected();
  voice.setVoicePhase("thinking"); // chat.sendText() started a turn
  lk.emit({ t: "transcript", text: "Ach und noch" });
  lk.emit({ t: "transcript", text: "eine Sache" });
  assert.deepEqual(transcripts, []); // chat.sendText would have dropped them

  voice.beginSpeakStream();
  voice.pushSpeakStream("Alles klar.");
  voice.endSpeakStream("Alles klar.");
  const id = cmds(lk).find((c) => c.t === "speak_begin").id;
  lk.emit({ t: "agent_state", state: "speaking" });
  assert.equal(base.getPhase(), "speaking");
  lk.emit({ t: "speak_done", id, interrupted: false });

  assert.deepEqual(transcripts, ["Ach und noch eine Sache"]);
  assert.equal(base.getPhase(), "listening");
});

test("founder talking over the agent switches the UI back to listening and stops sending text", async () => {
  const { voice, base, lk } = await connected();
  voice.setVoicePhase("thinking");
  voice.beginSpeakStream();
  voice.pushSpeakStream("Das ist eine lange ");
  lk.emit({ t: "agent_state", state: "speaking" });
  lk.emit({ t: "user_state", state: "speaking" });
  assert.equal(base.getPhase(), "listening");

  const before = lk.sent.length;
  voice.pushSpeakStream("Antwort, die niemand mehr hört.");
  await flush();
  assert.equal(lk.sent.slice(before).filter((c) => c.t === "speak_chunk").length, 0);
});

// ---------- speaking ----------------------------------------------------------------------

test("reply text reaches the worker as batched pieces, with control gates removed", async () => {
  const { voice, lk } = await connected();
  voice.beginSpeakStream();
  for (const piece of ["Danke. ", "Wie viele ", "Gründer?", " [[", "dossier:", "yes]]"]) voice.pushSpeakStream(piece);
  voice.endSpeakStream("Danke. Wie viele Gründer? [[dossier:yes]]");
  await flush();

  const sent = cmds(lk);
  const begin = sent.find((c) => c.t === "speak_begin");
  const text = sent.filter((c) => c.t === "speak_chunk" && c.id === begin.id).map((c) => c.text).join("");
  assert.equal(text.trim(), "Danke. Wie viele Gründer?");
  assert.ok(!text.includes("["));
  assert.equal(sent.at(-1).t, "speak_end");
  assert.ok(lk.sent.every((c) => c.topic === "sv.cmd"));
});

test("'Antworten vorlesen' off: the reply is shown but never sent to the worker", async () => {
  const { voice, lk } = await connected({ prefs: { voice: false } });
  const before = lk.sent.length;
  voice.beginSpeakStream();
  voice.pushSpeakStream("Still.");
  voice.endSpeakStream("Still.");
  await flush();
  assert.equal(lk.sent.slice(before).filter((c) => c.t === "speak_begin" || c.t === "speak_chunk").length, 0);
});

test("one-shot speech (greeting / Weiter fragen) uses say with gates removed", async () => {
  const { voice, lk } = await connected();
  await voice.speak("Weiter geht's. [[intake:end]]");
  assert.deepEqual(cmds(lk).filter((c) => c.t === "say").map(({ t, text }) => [t, text]), [["say", "Weiter geht's."]]);
});

test("stopSpeak cancels the worker's speech and clears the classic player too", async () => {
  const { voice, base, lk } = await connected();
  voice.stopSpeak();
  assert.ok(base.calls.some((c) => c[0] === "stopSpeak"));
  assert.ok(cmds(lk).some((c) => c.t === "speak_cancel"));
});

// ---------- outside a call ----------------------------------------------------------------

test("without a call everything falls through to classic (e.g. the greeting is spoken classically)", async () => {
  const { voice, base } = setup();
  await voice.speak("Hallo", { force: true });
  voice.beginSpeakStream({ force: false });
  voice.pushSpeakStream("x");
  voice.endSpeakStream("x");
  voice.stopMicCapture({ keepPhase: true });
  const names = base.calls.map((c) => c[0]);
  for (const n of ["speak", "beginSpeakStream", "pushSpeakStream", "endSpeakStream", "stopMicCapture"]) {
    assert.ok(names.includes(n), `${n} should reach classic`);
  }
});

test("a reply that began classically is finished classically even if a call starts mid-reply", async () => {
  const t = setup();
  t.voice.beginSpeakStream();               // not connected yet -> classic
  t.voice.onMicClick();                     // call starts while the reply streams
  await flush();
  t.voice.pushSpeakStream("Rest.");
  t.voice.endSpeakStream("Rest.");
  assert.ok(t.base.calls.some((c) => c[0] === "pushSpeakStream"));
  assert.ok(!t.lk.sent.some((c) => c.t === "speak_chunk"));
});

// ---------- ending a call -----------------------------------------------------------------

test("chat.js's per-turn stopMicCapture does not hang up the call", async () => {
  const { voice, base } = await connected();
  const before = base.calls.length;
  voice.stopMicCapture({ keepPhase: true });
  assert.equal(base.calls.length, before);
  assert.equal(voice.isConnected(), true);
});

test("mic click: skip the reply while speaking, hang up while listening", async () => {
  const { voice, base, lk } = await connected();
  base.setVoicePhase("speaking");
  voice.onMicClick();
  assert.equal(voice.isConnected(), true);
  assert.ok(cmds(lk).some((c) => c.t === "speak_cancel"));

  assert.equal(base.getPhase(), "listening");
  voice.onMicClick();
  assert.equal(voice.isConnected(), false);
  assert.equal(lk.state.disconnected, 1);
  assert.equal(base.getPhase(), "idle");
});

test("mic click while thinking aborts the turn (after confirmation) and stays in the call", async () => {
  const { voice, base, aborts } = await connected();
  base.setVoicePhase("thinking");
  voice.onMicClick();
  assert.equal(aborts.length, 1);
  assert.equal(voice.isConnected(), true);
});

test("switching to another conversation ends the call; a language change is passed on", async () => {
  const t = await connected();
  t.ctx.language = "en-US";
  t.voice.onSessionChange();
  assert.deepEqual(cmds(t.lk).filter((c) => c.t === "config"), [{ t: "config", language: "en" }]);

  t.ctx.sessionId = "other";
  t.voice.onSessionChange();
  assert.equal(t.voice.isConnected(), false);
  assert.equal(t.lk.state.disconnected, 1);
});

test("the voice agent leaving the room ends the call", async () => {
  const { voice, lk } = await connected();
  lk.handlers.pd({ kind: 4 });
  assert.equal(voice.isConnected(), false);
});

test("while selected, classic's own Stop button is intercepted so it hangs up the call", async () => {
  const { voice } = await connected();
  voice.activate();
  const capture = clickListeners.filter((l) => l.type === "click" && l.capture).at(-1);
  let stopped = false;
  capture.fn({
    target: { closest: (sel) => (sel === "#listenStopBtn" ? {} : null) },
    preventDefault() {}, stopImmediatePropagation() { stopped = true; },
  });
  assert.equal(stopped, true);
  assert.equal(voice.isConnected(), false);
});


// ---------- browser-side Whisper (the worker only speaks) --------------------------------

function fakeBrowserStt({ enabled = true, transcribe } = {}) {
  const st = { handlers: null, started: 0, stopped: 0, prepared: 0, transcribed: [] };
  st.api = {
    isEnabled: () => enabled,
    prepare: async () => { st.prepared += 1; },
    createListener: (h) => { st.handlers = h; return { start: async () => { st.started += 1; }, stop: () => { st.stopped += 1; } }; },
    transcribe: async (samples, rate, lang) => { st.transcribed.push([samples.length, rate, lang]); return transcribe ? transcribe() : "Wir sind zwei Gründer"; },
  };
  return st;
}

test("browser Whisper: asks the server for stt=browser, keeps the mic local, loads Whisper first", async () => {
  const st = fakeBrowserStt();
  const t = await connected({ browserStt: st.api });
  assert.equal(t.joins[0].body.stt, "browser");
  assert.equal(st.prepared, 1);
  assert.equal(st.started, 1);
  assert.equal(t.voice.isConnected(), true);
  assert.equal(t.voice.sttLabel(), "LiveKit · Whisper (Browser)");
});

test("browser Whisper off: the worker listens (stt=server) and no local listener starts", async () => {
  const st = fakeBrowserStt({ enabled: false });
  const t = await connected({ browserStt: st.api });
  assert.equal(t.joins[0].body.stt, "server");
  assert.equal(st.started, 0);
});

test("browser Whisper: a finished utterance is transcribed locally and sent like a typed answer", async () => {
  const st = fakeBrowserStt();
  const t = await connected({ browserStt: st.api });
  st.handlers.onUtterance(new Float32Array(16000), 48000);
  await flush();
  assert.deepEqual(st.transcribed, [[16000, 48000, "de"]]);
  assert.deepEqual(t.transcripts, ["Wir sind zwei Gründer"]);
});

test("browser Whisper: hallucinated empty transcripts are ignored; utterances stay in order", async () => {
  const answers = [".", "Erstens", "Zweitens"]; const st = fakeBrowserStt({ transcribe: () => answers.shift() });
  const t = await connected({ browserStt: st.api });
  for (let i = 0; i < 3; i += 1) st.handlers.onUtterance(new Float32Array(10), 16000);
  await flush();
  assert.deepEqual(t.transcripts, ["Erstens", "Zweitens"]);
});

test("browser Whisper: you start talking over the agent -> its voice is cut immediately", async () => {
  const st = fakeBrowserStt();
  const t = await connected({ browserStt: st.api });
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Das ist eine lange Antwort. ");
  t.lk.emit({ t: "agent_state", state: "speaking" });
  assert.equal(t.base.getPhase(), "speaking");
  st.handlers.onSpeechStart();
  assert.equal(t.base.getPhase(), "listening");
  assert.ok(cmds(t.lk).some((c) => c.t === "speak_cancel"));
  assert.equal(st.handlers.getSensitivity(), 1); // normal pickiness again once it is quiet
});

test("browser Whisper: the listener is deaf while the agent speaks, and stops when the call ends", async () => {
  const st = fakeBrowserStt();
  const t = await connected({ browserStt: st.api });
  t.base.setVoicePhase("speaking");
  assert.ok(st.handlers.getSensitivity() >= 1e5);
  t.base.setVoicePhase("listening");
  t.voice.onMicClick(); // hang up
  assert.equal(st.stopped, 1);
});

test("browser Whisper: a microphone that cannot be opened ends the attempt with an error", async () => {
  const st = fakeBrowserStt();
  st.api.createListener = () => ({ start: async () => { throw new Error("Permission denied"); }, stop() {} });
  const t = setup({ browserStt: st.api });
  t.voice.onMicClick();
  await flush();
  assert.equal(t.voice.isConnected(), false);
  assert.match(t.base.calls.filter((c) => c[0] === "setVoicePhase").at(-1)[2], /Permission denied/);
});


// ---------- "I'm listening" must be obvious: live bubble, wave, orb ------------------------

const names = (base) => base.calls.map((c) => c[0]);

test("live words from the worker appear in the chat bubble, not just the status line", async () => {
  const { base, lk } = await connected();
  lk.emit({ t: "interim", text: "Wir sind zwei" });
  assert.deepEqual(base.calls.filter((c) => c[0] === "paintSttPreview").at(-1), ["paintSttPreview", "Wir sind zwei"]);
});

test("the live bubble is cleared when the final transcript is sent as the real message", async () => {
  const { base, lk, transcripts } = await connected();
  lk.emit({ t: "interim", text: "Wir sind zwei" });
  lk.emit({ t: "transcript", text: "Wir sind zwei Gründer" });
  const order = names(base).filter((n) => n === "paintSttPreview" || n === "clearLiveBubble");
  assert.equal(order.at(-1), "clearLiveBubble");
  assert.deepEqual(transcripts, ["Wir sind zwei Gründer"]);
});

test("speech heard while the reply is pending stays visible as a pending bubble", async () => {
  const { voice, base, lk } = await connected();
  voice.setVoicePhase("thinking");
  lk.emit({ t: "transcript", text: "Ach und noch eine Sache" });
  assert.deepEqual(base.calls.filter((c) => c[0] === "paintSttPreview").at(-1), ["paintSttPreview", "Ach und noch eine Sache"]);
});

test("browser Whisper: a waiting bubble shows while you talk, 'Transcribing…' while Whisper works", async () => {
  const st = fakeBrowserStt();
  const t = await connected({ browserStt: st.api });
  st.handlers.onSpeechStart();
  assert.deepEqual(t.base.calls.filter((c) => c[0] === "paintSttPreview").at(-1), ["paintSttPreview", ""]);
  st.handlers.onUtterance(new Float32Array(10), 16000);
  assert.match(t.base.calls.filter((c) => c[0] === "paintSttPreview").at(-1)[1], /Transkribiere/);
  await flush();
  assert.equal(names(t.base).filter((n) => n === "clearLiveBubble").length > 0, true);
});

test("the wave and orb meter start when the call is live and stop when it ends", async () => {
  const t = await connected();
  assert.ok(names(t.base).includes("startWaveform"), "wave runs from the call's mic track");
  const stream = t.base.calls.find((c) => c[0] === "startWaveform")[1];
  assert.deepEqual(stream.tracks, [{ id: "mic" }]);
  t.base.calls.length = 0;
  t.voice.setVoicePhase("listening");
  t.voice.onMicClick(); // hang up
  assert.ok(names(t.base).includes("stopWaveform"));
});

test("browser Whisper: the wave uses the listener's own microphone stream", async () => {
  const st = fakeBrowserStt();
  const own = { own: true };
  st.api.createListener = (h) => { st.handlers = h; return { start: async () => {}, stop() {}, getStream: () => own }; };
  const t = await connected({ browserStt: st.api });
  assert.equal(t.base.calls.find((c) => c[0] === "startWaveform")[1], own);
});


// ---------- audio cues --------------------------------------------------------------------

const fakeCues = (ms = 100) => { const played = []; return { played, play: (n) => { played.push(n); return ms; } }; };

test("cues: 'listen' when the call opens and again when it is your turn after a reply", async () => {
  const cues = fakeCues();
  const t = await connected({ cues });
  assert.deepEqual(cues.played, ["listen"]);
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Danke.");
  t.voice.endSpeakStream("Danke.");
  const id = cmds(t.lk).find((c) => c.t === "speak_begin").id;
  t.lk.emit({ t: "agent_state", state: "speaking" });
  t.lk.emit({ t: "speak_done", id, interrupted: false });
  assert.deepEqual(cues.played, ["listen", "listen"]);
});

test("cues: no repeated 'listen' while you are already being listened to", async () => {
  const cues = fakeCues();
  const t = await connected({ cues });
  t.voice.setVoicePhase("idle"); // maps to listening again
  t.lk.emit({ t: "user_state", state: "speaking" });
  assert.deepEqual(cues.played, ["listen"]);
});

test("cues: 'heard' when your answer arrives, not for noise", async () => {
  const cues = fakeCues();
  const t = await connected({ cues });
  t.lk.emit({ t: "transcript", text: "." });
  assert.deepEqual(cues.played, ["listen"]);
  t.lk.emit({ t: "transcript", text: "Wir sind zwei Gründer" });
  assert.deepEqual(cues.played, ["listen", "heard"]);
});

test("cues: 'end' when you hang up", async () => {
  const cues = fakeCues();
  const t = await connected({ cues });
  t.voice.onMicClick();
  assert.equal(cues.played.at(-1), "end");
});

test("cues: the browser's speech detector stays deaf while a cue is ringing", async () => {
  const st = fakeBrowserStt();
  const cues = fakeCues(150);
  const t = await connected({ browserStt: st.api, cues });
  assert.ok(st.handlers.getSensitivity() >= 1e5); // right after the 'listen' cue
  await new Promise((r) => setTimeout(r, 650));
  assert.equal(st.handlers.getSensitivity(), 1);   // cue (150 ms) + 400 ms margin are over
});

test("cues: a failed connection plays nothing", async () => {
  const cues = fakeCues();
  const t = setup({ lk: fakeLiveKit({ autoReady: false }), readyTimeoutMs: 30, cues });
  t.voice.onMicClick();
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(cues.played, []);
});


// ---------- "which speak mode is this?" must be visible ----------------------------------

const modeUis = (base) => base.calls.filter((c) => c[0] === "setModeUi").map((c) => c[1]);

test("mode UI: selecting the live mode shows 'Live-Gespräch' and 'Live-Gespräch starten'", () => {
  const t = setup();
  t.voice.activate();
  const ui = modeUis(t.base).at(-1);
  assert.match(ui.pill.de, /Live-Gespräch/);
  assert.equal(ui.pill.icon, "livekit"); // the LiveKit mark is drawn in front of the text
  assert.equal(ui.pill.live, false);
  assert.equal(ui.labels.idle.de, "Live-Gespräch starten");
  assert.equal(ui.labels.idle.en, "Start live call");
});

test("mode UI: in a call the pill turns LIVE and the button says 'Auflegen', not 'Stopp'", async () => {
  const t = await connected();
  t.voice.activate();
  t.base.calls.length = 0;
  const t2 = await connected();
  const ui = modeUis(t2.base).at(-1);
  assert.equal(ui.pill.live, true);
  assert.match(ui.pill.de, /LIVE/);
  assert.match(ui.pill.de, /LiveKit-Agent/);
  assert.equal(ui.pill.agent.speaking.de, "spricht");
  assert.equal(ui.labels.listening.de, "Auflegen");
  assert.equal(ui.labels.listening.titleDe, "Gespräch beenden");
  assert.equal(ui.stop.de, "Auflegen");
});

test("mode UI: hanging up goes back to the idle live wording, switching away restores classic", async () => {
  const t = await connected();
  t.voice.activate();
  t.voice.onMicClick(); // listening -> hang up
  assert.equal(modeUis(t.base).at(-1).pill.live, false);
  t.voice.deactivate();
  assert.equal(modeUis(t.base).at(-1), null);
});

test("mode UI: the English words are there too", () => {
  const t = setup();
  t.voice.activate();
  const ui = modeUis(t.base).at(-1);
  assert.equal(ui.labels.listening.en, "Hang up");
  assert.equal(ui.labels.speaking.en, "Interrupt");
  assert.match(ui.pill.en, /Live call/);
});

test("mode UI: while joining the room the pill says so and the button reads 'Verbinde… (Abbrechen)'", async () => {
  const t = setup({ lk: fakeLiveKit({ autoReady: false }), readyTimeoutMs: 400 });
  t.voice.activate();
  t.voice.onMicClick(); // connect() starts, the agent never says ready
  await new Promise((r) => setTimeout(r, 30));
  const ui = modeUis(t.base).at(-1);
  assert.equal(ui.pill.connecting, true);
  assert.match(ui.pill.de, /verbindet/);
  assert.equal(ui.labels.thinking.de, "Verbinde… (Abbrechen)");
  assert.equal(modeUis(t.base).find((u) => u.pill.live), undefined);
});

test("cancel while connecting: the click now ends the attempt (it used to do nothing for 15 s)", async () => {
  const t = setup({ lk: fakeLiveKit({ autoReady: false }), readyTimeoutMs: 400 });
  t.voice.activate();
  t.voice.onMicClick();
  await new Promise((r) => setTimeout(r, 30));
  t.voice.onMicClick(); // [Verbinde… (Abbrechen)]
  assert.equal(t.voice.isConnected(), false);
  assert.equal(phases(t.base).at(-1), "idle");
  assert.equal(modeUis(t.base).at(-1).pill.connecting, undefined);
  // the abandoned attempt's timeout must not resurrect an error after the cancel
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(phases(t.base).at(-1), "idle");
  assert.ok(t.lk.state.disconnected >= 1);
});

// ---------- a provider gives up mid-call (ElevenLabs quota, bad key, outage) -------------------

test("worker TTS gives up: the call stays open and replies move to the classic (browser) voice", async () => {
  const t = await connected();
  t.lk.emit({ t: "error", scope: "tts", message: "Kontingent aufgebraucht" });
  assert.equal(t.voice.isConnected(), true);
  assert.match(t.base.calls.filter((c) => c[0] === "setStatus").at(-1)[1], /Kontingent aufgebraucht.*Browser-Stimme/);
  t.base.calls.length = 0;
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Hallo");
  t.voice.endSpeakStream("Hallo");
  await t.voice.speak("Hi");
  const names = t.base.calls.map((c) => c[0]);
  for (const n of ["beginSpeakStream", "pushSpeakStream", "endSpeakStream", "speak"]) assert.ok(names.includes(n), n);
  assert.deepEqual(cmds(t.lk).filter((c) => c.t === "speak_begin" || c.t === "say"), []);
});

test("worker STT gives up, no browser Whisper: the call ends with a tip that points to Whisper (Browser)", async () => {
  const t = await connected();
  t.lk.emit({ t: "error", scope: "stt", message: "Kontingent aufgebraucht" });
  await flush();
  assert.equal(t.voice.isConnected(), false);
  const last = t.base.calls.filter((c) => c[0] === "setVoicePhase").at(-1);
  assert.equal(last[1], "idle");
  assert.match(last[2], /Kontingent aufgebraucht/);
  assert.match(last[2], /Whisper \(Browser\)/);
});

test("worker STT gives up, browser Whisper available: the call carries on with Whisper + the browser voice", async () => {
  const st = fakeBrowserStt({ enabled: false }); // server STT was selected, so the worker was the ear
  const t = await connected({ browserStt: st.api });
  assert.equal(st.started, 0);
  t.lk.emit({ t: "error", scope: "stt", message: "Kontingent aufgebraucht" });
  await flush();
  assert.equal(t.voice.isConnected(), true);
  assert.equal(st.prepared, 1);
  assert.equal(st.started, 1);
  assert.equal(phases(t.base).at(-1), "listening");
  // the worker's session died with its STT: the agent leaving the room must not end the call now
  t.lk.handlers.pd({ kind: 4 });
  assert.equal(t.voice.isConnected(), true);
  // heard speech reaches the chat through browser Whisper
  st.handlers.onUtterance(new Float32Array(16000), 16000);
  await flush();
  assert.deepEqual(t.transcripts, ["Wir sind zwei Gründer"]);
  // and replies are spoken by the classic voice, never by the dead worker
  t.base.calls.length = 0;
  await t.voice.speak("Hi");
  assert.ok(t.base.calls.some((c) => c[0] === "speak"));
  assert.deepEqual(cmds(t.lk).filter((c) => c.t === "say"), []);
});

test("an error without a scope keeps the call open: message shown, still listening (never the 'start' button)", async () => {
  const t = await connected();
  t.lk.emit({ t: "error", message: "something odd" });
  assert.equal(t.voice.isConnected(), true);
  assert.equal(phases(t.base).at(-1), "listening");
  assert.equal(t.base.calls.filter((c) => c[0] === "setVoicePhase").at(-1)[2], "something odd");
});


// ---------- a failing worker voice must not swallow the reply that was in flight ----------

const ttsDown = (lk) => lk.emit({ t: "error", scope: "tts", message: "Das Kontingent des Sprachanbieters ist aufgebraucht" });

test("voice fails after the reply was sent: that same reply is spoken by the browser voice", async () => {
  const t = await connected();
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Danke, das ist hilfreich. [[dossier:yes]]");
  t.voice.endSpeakStream("Danke, das ist hilfreich. [[dossier:yes]]");
  ttsDown(t.lk);
  const spoke = t.base.calls.filter((c) => c[0] === "speak");
  assert.equal(spoke.length, 1);
  assert.equal(spoke[0][1].trim(), "Danke, das ist hilfreich.");
});

test("voice fails while the reply is still streaming: the rest continues in the browser voice, nothing is said twice", async () => {
  const t = await connected();
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Erster Satz. ");
  ttsDown(t.lk);
  t.voice.pushSpeakStream("Zweiter Satz.");
  t.voice.endSpeakStream("Erster Satz. Zweiter Satz.");
  const names = t.base.calls.map((c) => c[0]);
  assert.ok(names.includes("beginSpeakStream") && names.includes("endSpeakStream"));
  const pushed = t.base.calls.filter((c) => c[0] === "pushSpeakStream").map((c) => c[1]).join("");
  assert.match(pushed, /Erster Satz\./);
  assert.match(pushed, /Zweiter Satz\./);
  assert.equal(pushed.match(/Erster Satz/g).length, 1, "the first sentence must not be repeated");
});

test("after the voice failed, the worker's late speak_done does not flip the phase while the browser voice talks", async () => {
  const t = await connected();
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Antwort.");
  t.voice.endSpeakStream("Antwort.");
  const id = cmds(t.lk).find((c) => c.t === "speak_begin").id;
  ttsDown(t.lk);
  t.base.setVoicePhase("speaking"); // the browser voice is talking now
  t.lk.emit({ t: "speak_done", id, interrupted: false });
  assert.equal(t.base.getPhase(), "speaking");
});

test("a second voice error does not make the browser repeat the reply", async () => {
  const t = await connected();
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Antwort.");
  t.voice.endSpeakStream("Antwort.");
  ttsDown(t.lk);
  ttsDown(t.lk);
  assert.equal(t.base.calls.filter((c) => c[0] === "speak").length, 1);
});

test("voice off ('read aloud' unchecked): a failing voice does not start speaking anyway", async () => {
  const t = await connected({ prefs: { voice: false } });
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Still.");
  t.voice.endSpeakStream("Still.");
  ttsDown(t.lk);
  assert.equal(t.base.calls.filter((c) => c[0] === "speak").length, 0);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a worker voice that never starts talking (no error event either) is replaced by the browser voice", async () => {
  const t = await connected({ voiceStartTimeoutMs: 40 });
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Antwort.");
  t.voice.endSpeakStream("Antwort.");
  await sleep(90);
  assert.equal(t.base.calls.filter((c) => c[0] === "speak").length, 1, "browser voice says the reply");
});

test("a worker voice that starts talking in time is left alone", async () => {
  const t = await connected({ voiceStartTimeoutMs: 40 });
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Antwort.");
  t.voice.endSpeakStream("Antwort.");
  t.lk.emit({ t: "agent_state", state: "speaking" });
  await sleep(90);
  assert.equal(t.base.calls.filter((c) => c[0] === "speak").length, 0);
});

test("skipping the reply cancels the start watchdog", async () => {
  const t = await connected({ voiceStartTimeoutMs: 40 });
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Antwort.");
  t.voice.endSpeakStream("Antwort.");
  t.voice.stopSpeak();
  await sleep(90);
  assert.equal(t.base.calls.filter((c) => c[0] === "speak").length, 0);
});

// ---------- Whisper loads while the room connects ---------------------------------------------

test("Whisper starts loading at once, not after the room connected and the worker answered", async () => {
  const order = [];
  const st = fakeBrowserStt();
  st.api.prepare = async () => { order.push("prepare"); };
  const lk = fakeLiveKit();
  const origConnect = lk.client.Room.prototype.connect;
  lk.client.Room.prototype.connect = async function connect(...a) { order.push("room.connect"); return origConnect.apply(this, a); };
  await connected({ browserStt: st.api, lk });
  assert.ok(order.includes("prepare") && order.includes("room.connect"), `both ran: ${order}`);
  assert.ok(order.indexOf("prepare") < order.indexOf("room.connect"), `prepare before connect: ${order}`);
});

test("a failing Whisper load is reported, not an unhandled rejection", async () => {
  const st = fakeBrowserStt();
  st.api.prepare = async () => { throw new Error("download failed"); };
  const t = await connected({ browserStt: st.api });
  assert.equal(t.voice.isConnected(), false);
  assert.match(t.base.calls.filter((c) => c[0] === "setVoicePhase").at(-1)[2], /download failed/);
});

// ---------- the ears follow Settings > speech recognition -------------------------------------

function fakeWebSpeech({ supported = true, enabled = true } = {}) {
  const ws = { opts: null, started: 0, stopped: 0 };
  ws.api = {
    isSupported: () => supported,
    isEnabled: () => enabled,
    create: (opts) => { ws.opts = opts; return { start: async () => { ws.started += 1; }, stop: () => { ws.stopped += 1; } }; },
  };
  return ws;
}

test("Settings = Web Speech: the call listens with the browser recognizer and never downloads Whisper", async () => {
  const st = fakeBrowserStt({ enabled: false });
  const ws = fakeWebSpeech();
  const t = await connected({ browserStt: st.api, webSpeech: ws.api });
  assert.equal(t.joins[0].body.stt, "browser", "the worker must not listen");
  assert.equal(st.prepared, 0, "no Whisper download");
  assert.equal(ws.started, 1);
  ws.opts.onFinal("Wir sind zwei Gründer");
  assert.deepEqual(t.transcripts, ["Wir sind zwei Gründer"]);
});

test("Web Speech ignores what it hears while the agent speaks", async () => {
  const ws = fakeWebSpeech();
  const t = await connected({ browserStt: fakeBrowserStt({ enabled: false }).api, webSpeech: ws.api });
  t.base.setVoicePhase("speaking");
  assert.equal(ws.opts.isPaused(), true);
  t.base.setVoicePhase("listening");
  assert.equal(ws.opts.isPaused(), false);
});

test("server STT dies, Web Speech available: use it, do not download Whisper, say which", async () => {
  const st = fakeBrowserStt({ enabled: false });
  const ws = fakeWebSpeech({ enabled: false }); // the user picked a server provider
  const t = await connected({ browserStt: st.api, webSpeech: ws.api });
  t.lk.emit({ t: "error", scope: "stt", message: "Kontingent aufgebraucht" });
  await flush();
  assert.equal(st.prepared, 0);
  assert.equal(ws.started, 1);
  assert.match(t.base.calls.filter((c) => c[0] === "setVoicePhase").at(-1)[2], /Web Speech/);
  assert.equal(t.voice.isConnected(), true);
});

test("server STT dies, no Web Speech in this browser: Whisper takes over", async () => {
  const st = fakeBrowserStt({ enabled: false });
  const ws = fakeWebSpeech({ supported: false, enabled: false });
  const t = await connected({ browserStt: st.api, webSpeech: ws.api });
  t.lk.emit({ t: "error", scope: "stt", message: "Kontingent aufgebraucht" });
  await flush();
  assert.equal(st.prepared, 1);
  assert.match(t.base.calls.filter((c) => c[0] === "setVoicePhase").at(-1)[2], /Whisper/);
});

// ---------- Whisper hallucinations ------------------------------------------------------------

const { looksHallucinated } = await import("../../src/startup_voice/features/voice/ui/voice-livekit.js");

test("looksHallucinated drops loops and keeps real speech", () => {
  const loop = "Schau mal, was ich nicht so gut war. Ich bin gut, ich bin gut. Ich bin gut, ich bin gut. Du bist der Fisch. Du bist ein bisschen gut.";
  assert.equal(looksHallucinated(loop), true);
  assert.equal(looksHallucinated("ja ja ja"), false, "three is how people really talk");
  assert.equal(looksHallucinated("Danke Danke Danke Danke"), true);
  for (const ok of ["ja ja", "ja ja ja", "Ja, genau, das ist unser Ziel.", "Wir sind zwei Gründer und bauen eine App für Studierende.",
    "Wir wollen wachsen und wachsen und dann exportieren"]) {
    assert.equal(looksHallucinated(ok), false, ok);
  }
});

test("a hallucinated utterance is never sent as the founder's turn", async () => {
  const st = fakeBrowserStt({ transcribe: () => "Ich bin gut, ich bin gut. Ich bin gut, ich bin gut." });
  const t = await connected({ browserStt: st.api });
  st.handlers.onUtterance(new Float32Array(16000), 16000);
  await flush();
  assert.deepEqual(t.transcripts, []);
});

// ---------- the button reads like a call in every phase ---------------------------------------

test("in a call no phase falls back to a classic label (Sprechen / Verarbeitet / Live-Gespräch starten while talking)", async () => {
  const t = await connected();
  const ui = t.base.calls.filter((c) => c[0] === "setModeUi").at(-1)[1];
  assert.equal(ui.idleAs, "listening");
  for (const phase of ["listening", "thinking", "speaking"]) {
    const l = ui.labels[phase];
    assert.ok(l, `a call label for ${phase}`);
    assert.doesNotMatch(`${l.de} ${l.en}`, /Sprechen|Speak\b|Verarbeitet|Working/);
  }
  assert.match(ui.labels.speaking.de, /Unterbrechen/);
});

// ---------- Unterbrechen stops every voice ----------------------------------------------------

test("interrupting a reply that the BROWSER voice speaks stops it, and the rest of the stream is dropped", async () => {
  const t = await connected();
  ttsDown(t.lk); // the worker voice is gone: replies go through the classic voice
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Erster Satz. ");
  t.base.setVoicePhase("speaking");
  t.base.calls.length = 0;
  t.voice.onMicClick();
  assert.ok(t.base.calls.some((c) => c[0] === "stopSpeak"), "classic voice stopped");
  assert.equal(t.base.getPhase(), "listening");
  t.voice.pushSpeakStream("Zweiter Satz. ");
  t.voice.endSpeakStream("Erster Satz. Zweiter Satz. ");
  assert.equal(t.base.calls.filter((c) => c[0] === "pushSpeakStream" || c[0] === "endSpeakStream").length, 0);
  // the next reply speaks again
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Neu.");
  assert.equal(t.base.calls.filter((c) => c[0] === "pushSpeakStream").length, 1);
});

test("interrupting by talking over it (browser ears) stops both voices too", async () => {
  const st = fakeBrowserStt();
  const t = await connected({ browserStt: st.api });
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Antwort. ");
  t.base.setVoicePhase("speaking");
  t.base.calls.length = 0;
  st.handlers.onSpeechStart();
  assert.ok(t.base.calls.some((c) => c[0] === "stopSpeak"));
  assert.ok(cmds(t.lk).some((c) => c.t === "speak_cancel"));
  assert.equal(t.base.getPhase(), "listening");
});

// ---------- browser ears are deaf while the agent speaks --------------------------------------

test("browser ears cannot start while the agent speaks nor in the 700 ms after, then hear normally", async () => {
  const st = fakeBrowserStt();
  const t = await connected({ browserStt: st.api });
  const sens = st.handlers.getSensitivity;
  assert.equal(sens(), 1);
  t.base.setVoicePhase("speaking");
  assert.ok(sens() >= 1e5, "deaf while speaking");
  t.base.setVoicePhase("listening");
  assert.ok(sens() >= 1e5, "still deaf right after (echo tail)");
  await sleep(760);
  assert.equal(sens(), 1);
});

// ---------- hang up / interrupt silence the browser voice for good ----------------------------

test("hanging up silences the browser voice and drops the rest of the reply that is still streaming", async () => {
  const t = await connected();
  ttsDown(t.lk); // replies now go through the classic (browser) voice
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Erster Satz. ");
  t.base.calls.length = 0;
  t.base.setVoicePhase("listening");
  t.voice.onMicClick(); // Auflegen
  assert.equal(t.voice.isConnected(), false);
  assert.ok(t.base.calls.some((c) => c[0] === "stopSpeak"), "browser voice stopped");
  t.base.calls.length = 0;
  t.voice.pushSpeakStream("Zweiter Satz. ");
  t.voice.endSpeakStream("Erster Satz. Zweiter Satz. ");
  assert.equal(t.base.calls.filter((c) => c[0] === "pushSpeakStream" || c[0] === "endSpeakStream").length, 0);
});

test("a late worker TTS error after Unterbrechen does not replay the whole reply", async () => {
  const t = await connected();
  t.voice.setVoicePhase("thinking");
  t.voice.beginSpeakStream();
  t.voice.pushSpeakStream("Eine lange Antwort. ");
  t.voice.endSpeakStream("Eine lange Antwort. ");
  t.base.setVoicePhase("speaking");
  t.voice.onMicClick(); // Unterbrechen
  t.base.calls.length = 0;
  ttsDown(t.lk);
  assert.equal(t.base.calls.filter((c) => c[0] === "speak" || c[0] === "pushSpeakStream" || c[0] === "beginSpeakStream").length, 0);
});

// ---------- a worker that never answers takes the live mode away -------------------------------

test("when the voice worker never answers, the live mode stops being offered and the call falls back", async () => {
  const lk = fakeLiveKit({ autoReady: false });
  let unavailable = 0;
  const t = setup({ lk, readyTimeoutMs: 30 });
  // the real app passes this callback; setup() does not, so wire a second driver instance here
  const voice = createLiveKitVoice({
    base: t.base, prefs: { voice: true }, getLanguage: () => "de-DE", getSessionId: () => "s1", canListen: () => true,
    onTranscript() {}, onAbort() {}, api: async () => ({ url: "ws://x", token: "tok" }), loadClient: async () => lk.client,
    readyTimeoutMs: 30, onUnavailable: () => { unavailable += 1; },
  });
  voice.onMicClick();
  await sleep(120);
  assert.equal(unavailable, 1);
  assert.equal(voice.isConnected(), false);
  assert.match(t.base.calls.filter((c) => c[0] === "setVoicePhase").at(-1)[2], /Antippen & sprechen/);
});

test("the voice switch can drop a mode that failed", () => {
  const sw = createVoiceSwitch({ drivers: { classic: Object.fromEntries(METHODS.map((m) => [m, () => {}])), livekit: Object.fromEntries(METHODS.map((m) => [m, () => {}])) }, getPreferred: () => "livekit" });
  sw.setAvailableModes(["livekit"]);
  assert.equal(sw.getMode(), "livekit");
  sw.markUnavailable("livekit");
  assert.equal(sw.isAvailable("livekit"), false);
  assert.equal(sw.getMode(), "classic");
});
