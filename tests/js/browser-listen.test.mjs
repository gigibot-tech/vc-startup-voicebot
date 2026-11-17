// Run: node --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { createEndpointer, resampleTo16k } from "../../src/startup_voice/features/voice/ui/browser-listen.js";

const RATE = 16000;
const FRAME = 320; // 20 ms
const frame = (amp) => Float32Array.from({ length: FRAME }, (_, i) => amp * Math.sin(i / 3));
const feed = (ep, amp, ms, out) => { for (let t = 0; t < ms; t += 20) out.push(...ep.push(frame(amp), RATE)); };

test("a spoken phrase followed by a pause becomes one utterance (with pre-roll)", () => {
  const ep = createEndpointer(); const ev = [];
  feed(ep, 0.002, 600, ev);   // quiet room
  feed(ep, 0.2, 1200, ev);    // speaking
  feed(ep, 0.002, 1000, ev);  // pause
  assert.deepEqual(ev.map((e) => e.type), ["speechstart", "utterance"]);
  const u = ev[1];
  assert.equal(u.sampleRate, RATE);
  assert.ok(u.samples.length / RATE > 1.2, "includes the phrase plus pre-roll");
});

test("a short pause inside a sentence does not end the utterance", () => {
  const ep = createEndpointer(); const ev = [];
  feed(ep, 0.002, 400, ev);
  feed(ep, 0.2, 600, ev);
  feed(ep, 0.002, 500, ev);   // thinking pause < 900 ms
  feed(ep, 0.2, 600, ev);
  feed(ep, 0.002, 1000, ev);
  assert.deepEqual(ev.map((e) => e.type), ["speechstart", "utterance"]);
});

test("a click or cough is discarded, not transcribed", () => {
  const ep = createEndpointer({ startMs: 20, minSpeechMs: 250 }); const ev = [];
  feed(ep, 0.002, 400, ev);
  feed(ep, 0.3, 60, ev);
  feed(ep, 0.002, 1000, ev);
  assert.deepEqual(ev.map((e) => e.type), ["speechstart", "discard"]);
});

test("steady background noise adapts into the floor and never triggers", () => {
  const ep = createEndpointer(); const ev = [];
  feed(ep, 0.01, 3000, ev);
  assert.deepEqual(ev, []);
});

test("the same moderate sound triggers normally but not while the agent speaks (echo guard)", () => {
  const run = (sens) => {
    const ep = createEndpointer({ getSensitivity: () => sens }); const ev = [];
    feed(ep, 0.002, 200, ev);
    feed(ep, 0.03, 400, ev);
    return ev.map((e) => e.type);
  };
  assert.deepEqual(run(1), ["speechstart"]);
  assert.deepEqual(run(2.2), []);
});

test("resampleTo16k keeps duration and passes 16 kHz through untouched", () => {
  const src = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 50));
  const out = resampleTo16k(src, 48000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[100] - src[300]) < 0.02);
  assert.equal(resampleTo16k(src, 16000), src);
});
