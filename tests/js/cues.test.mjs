// Run: node --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { CUES, createCues, cueDurationMs } from "../../src/startup_voice/features/voice/ui/cues.js";

function fakeAudio() {
  const made = [];
  class Ctx {
    constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; Ctx.last = this; }
    createOscillator() { const o = { frequency: {}, connect: (g) => g, start() {}, stop() {} }; made.push(o); return o; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (d) => d }; }
    close() { this.state = "closed"; }
  }
  return { Ctx, made };
}

test("each cue plays its notes and reports how long it lasts", () => {
  const { Ctx, made } = fakeAudio();
  const cues = createCues({ AudioContextCtor: Ctx });
  assert.equal(cues.play("listen"), cueDurationMs("listen"));
  assert.deepEqual(made.map((o) => o.frequency.value), CUES.listen.map(([f]) => f));
  assert.equal(cues.play("heard"), 70);
  assert.ok(cueDurationMs("end") > cueDurationMs("heard"));
});

test("'listen' rises and 'end' falls, so they can be told apart without looking", () => {
  const rises = (n) => CUES[n][1][0] > CUES[n][0][0];
  assert.equal(rises("listen"), true);
  assert.equal(rises("end"), false);
});

test("disabled in Settings, unknown name or no Web Audio: silent, returns 0, never throws", () => {
  const { Ctx, made } = fakeAudio();
  assert.equal(createCues({ isEnabled: () => false, AudioContextCtor: Ctx }).play("listen"), 0);
  assert.equal(createCues({ AudioContextCtor: Ctx }).play("nope"), 0);
  assert.equal(made.length, 0);
  assert.equal(createCues({ AudioContextCtor: class { constructor() { throw new Error("blocked"); } } }).play("heard"), 0);
});
