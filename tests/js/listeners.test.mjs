// Web Speech ears and the wave noise gate, with a fake SpeechRecognition.
import assert from "node:assert/strict";
import test from "node:test";

import { createWebSpeechListener } from "../../src/startup_voice/features/voice/ui/web-speech-listen.js";
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

test("final results are delivered, interim ones only as a preview", async () => {
  const { Rec, made } = fakeCtor();
  const finals = []; const interims = [];
  const l = createWebSpeechListener({ lang: "de-DE", Ctor: Rec, onFinal: (t) => finals.push(t), onInterim: (t) => interims.push(t) });
  await l.start();
  assert.equal(made[0].lang, "de-DE");
  assert.equal(made[0].continuous, true);
  made[0].onresult(result("Wir sind", false));
  made[0].onresult(result("Wir sind zwei Gründer", true));
  assert.deepEqual(interims, ["Wir sind"]);
  assert.deepEqual(finals, ["Wir sind zwei Gründer"]);
});

test("results are dropped while paused (the agent is talking)", async () => {
  const { Rec, made } = fakeCtor();
  let paused = true; const finals = [];
  const l = createWebSpeechListener({ lang: "de-DE", Ctor: Rec, onFinal: (t) => finals.push(t), isPaused: () => paused });
  await l.start();
  made[0].onresult(result("Das sagt der Agent", true));
  paused = false;
  made[0].onresult(result("Das sagt der Mensch", true));
  assert.deepEqual(finals, ["Das sagt der Mensch"]);
});

test("Chrome ends the session after a pause: it is restarted until stop()", async () => {
  const { Rec, made } = fakeCtor();
  const l = createWebSpeechListener({ lang: "de-DE", Ctor: Rec, onFinal() {} });
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
  const l = createWebSpeechListener({ lang: "de-DE", Ctor: Rec, onFinal() {}, onError: (c) => errors.push(c) });
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
