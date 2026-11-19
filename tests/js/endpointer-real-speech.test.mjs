// Real speech (macOS `say`, tests/fixtures/make_speech.sh) through the browser's end-of-turn detector.
// Layout of the recording: speech 3.1 s | 0.5 s thinking pause | speech 2.5 s | 2.6 s silence | speech 1.9 s | silence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createEndpointer } from "../../src/startup_voice/features/voice/ui/browser-listen.js";

const WAV = new URL("../fixtures/speech_de_two_turns.wav", import.meta.url);

function readWav(buf) {
  const rate = buf.readUInt32LE(24);
  const dataAt = buf.indexOf(Buffer.from("data")) + 8;
  const n = (buf.length - dataAt) >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = buf.readInt16LE(dataAt + 2 * i) / 32768;
  return { rate, samples: out };
}

/** Feeds the recording in 20 ms frames, like the AudioWorklet does; returns events with timestamps. */
function run(samples, rate, { noise = 0, ...opts } = {}) {
  const ep = createEndpointer(opts);
  const frame = Math.round(rate * 0.02);
  const events = [];
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for (let i = 0; i + frame <= samples.length; i += frame) {
    const f = samples.slice(i, i + frame);
    if (noise) for (let k = 0; k < f.length; k += 1) f[k] += rand() * 2 * noise;
    for (const ev of ep.push(f, rate)) events.push({ ...ev, at: i / rate });
  }
  return events;
}

const { rate, samples } = readWav(readFileSync(WAV));
const utterances = (events) => events.filter((e) => e.type === "utterance");
const seconds = (u) => u.samples.length / u.sampleRate;

test("the fixture is what we think it is (16 kHz, ~14 s)", () => {
  assert.equal(rate, 16000);
  assert.ok(samples.length / rate > 13 && samples.length / rate < 15.5);
});

test("two spoken turns give exactly two utterances: the 0.5 s thinking pause does not split turn one", () => {
  const events = run(samples, rate);
  assert.deepEqual(events.map((e) => e.type), ["speechstart", "utterance", "speechstart", "utterance"]);
  const [a, b] = utterances(events);
  assert.ok(seconds(a) > 5.5, `turn one should hold both sentences, got ${seconds(a).toFixed(1)} s`);
  assert.ok(seconds(b) > 1.5 && seconds(b) < 3.5, `turn two ~1.9 s, got ${seconds(b).toFixed(1)} s`);
});

test("the turn ends ~0.9 s after the speaker stops, not instantly and not seconds later", () => {
  const events = run(samples, rate);
  const [first] = utterances(events);
  const speechEnds = 6.2; // end of turn one in the recording (see layout above)
  const delay = first.at - speechEnds;
  assert.ok(delay > 0.7 && delay < 1.5, `end-of-turn came ${delay.toFixed(2)} s after the last word`);
});

test("the second turn is only sent after its own silence, so one message per turn", () => {
  const events = run(samples, rate);
  const ends = utterances(events).map((e) => e.at);
  assert.ok(ends[1] > 10.5 && ends[1] < 12.5, `turn two should end around 11.5 s, got ${ends[1]?.toFixed(1)}`);
  assert.ok(ends[1] - ends[0] > 4);
});

test("a quieter room noise floor does not change the result", () => {
  const events = run(samples, rate, { noise: 0.004 });
  assert.equal(utterances(events).length, 2);
});

test("steady background hiss alone never starts a turn", () => {
  const silent = new Float32Array(rate * 8);
  assert.deepEqual(run(silent, rate, { noise: 0.01 }), []);
});

test("a shorter pause limit (0.4 s) splits the 0.5 s thinking pause: the setting is what decides", () => {
  const events = run(samples, rate, { endSilenceMs: 400 });
  assert.ok(utterances(events).length >= 3, "with a 0.4 s limit the 0.5 s thinking pause splits turn one");
});

test("the same speech at 48 kHz (what a real microphone delivers) gives the same two turns", () => {
  const up = new Float32Array(samples.length * 3);
  for (let i = 0; i < samples.length; i += 1) { up[3 * i] = up[3 * i + 1] = up[3 * i + 2] = samples[i]; }
  assert.equal(utterances(run(up, rate * 3)).length, 2);
});
