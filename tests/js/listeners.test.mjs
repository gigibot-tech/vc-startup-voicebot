// Web Speech ears and the wave noise gate, with a fake SpeechRecognition.
import assert from "node:assert/strict";
import test from "node:test";

import { createWebSpeechListener } from "../../src/startup_voice/features/voice/ui/web-speech-listen.js";
import { createSilenceEnd } from "../../src/startup_voice/features/voice/ui/silence-end.js";
import { createNoiseGate } from "../../src/startup_voice/features/voice/ui/wave-gate.js";

function fakeCtor() {
  const made = [];
  class Rec {
    constructor() { made.push(this); this.starts = 0; }
    start() { this.starts += 1; }
    stop() { this.stopped = true; }
  }
  return { Rec, made };
}
const result = (text, isFinal, resultIndex = 0) => ({ resultIndex, results: [Object.assign([{ transcript: text }], { isFinal })] });

function fakeTimers() {
  let next = 1; const pending = new Map();
  return {
    setTimer: (fn) => { const id = next++; pending.set(id, fn); return id; },
    clearTimer: (id) => pending.delete(id),
    fire() { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f()); },
    count: () => pending.size,
  };
}
const listener = (Rec, extra = {}) => {
  const timers = fakeTimers();
  const finals = []; const interims = [];
  const l = createWebSpeechListener({
    lang: "de-DE", Ctor: Rec, timers, onFinal: (t) => finals.push(t), onInterim: (t) => interims.push(t), ...extra,
  });
  return { l, timers, finals, interims };
};

test("words are collected and sent ONE quiet period after the last result (not when Chrome says final)", async () => {
  const { Rec, made } = fakeCtor();
  const { l, timers, finals, interims } = listener(Rec);
  await l.start();
  assert.equal(made[0].lang, "de-DE");
  made[0].onresult(result("Wir sind", false));
  made[0].onresult(result("Wir sind zwei Gründer", true));   // Chrome calls the phrase final ...
  assert.deepEqual(finals, [], "... but the turn is not over yet");
  made[0].onresult(result("und bauen eine App", false));      // she keeps talking: same turn
  assert.equal(timers.count(), 1, "one countdown, restarted by every result");
  timers.fire();                                              // silence
  assert.deepEqual(finals, ["Wir sind zwei Gründer und bauen eine App"]);
  assert.equal(interims.at(-1), "Wir sind zwei Gründer und bauen eine App");
});

test("after sending, the session is aborted so Chrome's late final cannot send the words twice", async () => {
  const { Rec, made } = fakeCtor();
  Rec.prototype.abort = function abort() { this.aborted = true; };
  const { l, timers, finals } = listener(Rec);
  await l.start();
  made[0].onresult(result("Hallo zusammen", false));
  timers.fire();
  assert.equal(made[0].aborted, true);
  assert.deepEqual(finals, ["Hallo zusammen"]);
  made[0].onend();                                  // abort ends the session: a fresh one starts
  assert.equal(made.length, 2);
  made[1].onresult(result("Zweite Antwort", false));
  timers.fire();
  assert.deepEqual(finals, ["Hallo zusammen", "Zweite Antwort"]);
});

test("nothing heard = nothing sent", async () => {
  const { Rec, made } = fakeCtor();
  const { l, timers, finals } = listener(Rec);
  await l.start();
  made[0].onresult(result("   ", false));
  timers.fire();
  assert.deepEqual(finals, []);
});

test("results are dropped while paused (the agent is talking)", async () => {
  const { Rec, made } = fakeCtor();
  let paused = true;
  const { l, timers, finals } = listener(Rec, { isPaused: () => paused });
  await l.start();
  made[0].onresult(result("Das sagt der Agent", true));
  timers.fire();
  paused = false;
  made[0].onresult(result("Das sagt der Mensch", true));
  timers.fire();
  assert.deepEqual(finals, ["Das sagt der Mensch"]);
});

test("Chrome ends the session after a pause: it is restarted until stop()", async () => {
  const { Rec, made } = fakeCtor();
  const { l } = listener(Rec);
  await l.start();
  made[0].onend();
  assert.equal(made.length, 2);
  assert.equal(made[1].starts, 1);
  l.stop();
  made[1].onend();
  assert.equal(made.length, 2, "no restart after stop");
});

test("a blocked microphone is reported once and does not restart in a loop", async () => {
  const { Rec, made } = fakeCtor();
  const errors = [];
  const { l } = listener(Rec, { onError: (c) => errors.push(c) });
  await l.start();
  made[0].onerror({ error: "not-allowed" });
  made[0].onend();
  assert.deepEqual(errors, ["not-allowed"]);
  assert.equal(made.length, 1);
});

test("wave gate: room hum stays at 0, speech opens it, the agent's own voice needs more", () => {
  const g = createNoiseGate();
  for (let i = 0; i < 200; i += 1) assert.equal(g.update(0.012 + (i % 3) * 0.002), 0);
  assert.ok(g.update(0.2) > 0.3, "speech opens the gate");
  const hum = createNoiseGate();
  for (let i = 0; i < 100; i += 1) hum.update(0.01);
  assert.ok(hum.update(0.07, false) > 0, "audible without the agent talking");
  assert.equal(hum.update(0.07, true), 0, "same level while the agent speaks = its own leak");
});

test("silence-end: every touch restarts the countdown and it fires once", () => {
  const t = fakeTimers(); let fired = 0;
  const s = createSilenceEnd({ quietMs: 1200, onQuiet: () => { fired += 1; }, ...t });
  s.touch(); s.touch(); s.touch();
  assert.equal(t.count(), 1);
  t.fire();
  assert.equal(fired, 1);
  assert.equal(s.isArmed(), false);
  s.touch(); s.cancel();
  t.fire();
  assert.equal(fired, 1, "cancelled");
});
