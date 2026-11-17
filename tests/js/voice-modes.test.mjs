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
    client: { Room, RoomEvent, Track: { Kind: { Audio: "audio" } }, ParticipantKind: { AGENT: 4 } },
  };
}

function setup({ lk = fakeLiveKit(), sessionId = "s1", prefs = {}, readyTimeoutMs = 200, browserStt = null } = {}) {
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

test("browser Whisper: the listener is pickier while the agent speaks, and stops when the call ends", async () => {
  const st = fakeBrowserStt();
  const t = await connected({ browserStt: st.api });
  t.base.setVoicePhase("speaking");
  assert.equal(st.handlers.getSensitivity(), 2.2);
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
