// Run: node --test tests/js/*.test.mjs   (pytest runs it too when `node` is installed)
import assert from "node:assert/strict";
import test from "node:test";

import { createGateFilter, stripGates } from "../../src/startup_voice/features/voice/ui/speak-gate.js";

function run(chunks, final) {
  const g = createGateFilter();
  const spoken = chunks.map((c) => g.push(c)).join("");
  return { spoken, tail: g.finish(final ?? chunks.join("")), g };
}

test("plain text passes straight through", () => {
  const { spoken, tail } = run(["Hallo, ", "wer seid ihr?"]);
  assert.equal(spoken, "Hallo, wer seid ihr?");
  assert.equal(tail, "");
});

test("a gate arriving in one chunk is dropped", () => {
  const { spoken } = run(["Danke. ", "[[dossier:yes]]"]);
  assert.equal(spoken.trim(), "Danke.");
});

test("a gate split across tokens is held back, never spoken", () => {
  const { spoken } = run(["Okay.", " [[", "dossi", "er:", "no", "]]"]);
  assert.equal(spoken.trim(), "Okay.");
  assert.ok(!spoken.includes("["));
});

test("the end gate is dropped too", () => {
  const { spoken } = run(["Das war's.", "[[intake:end]]"]);
  assert.equal(spoken.trim(), "Das war's.");
});

test("a lone '[' at the end of a chunk is held until the next one decides", () => {
  const g = createGateFilter();
  assert.equal(g.push("Siehe ["), "Siehe ");
  assert.equal(g.push("1] dort"), "[1] dort");
});

test("brackets that are not gates are released as text", () => {
  const { spoken } = run(["Preis [[siehe Anhang]] ok"]);
  assert.equal(spoken, "Preis [[siehe Anhang]] ok");
});

test("a never-closing '[[' is released once it is too long to be a gate", () => {
  const g = createGateFilter();
  const out = g.push("[[" + "x".repeat(60));
  assert.ok(out.startsWith("[["));
});

test("finish() returns only the part that was not released yet", () => {
  const g = createGateFilter();
  g.push("Wie viele Gründer ");
  assert.equal(g.finish("Wie viele Gründer seid ihr? [[dossier:no]]"), "seid ihr?");
});

test("finish() keeps words apart when the spoken part had no trailing space", () => {
  const g = createGateFilter();
  g.push("Wie viele Gründer");
  assert.equal(g.finish("Wie viele Gründer seid ihr?"), " seid ihr?");
});

test("finish() never re-speaks or contradicts what was already said", () => {
  const g = createGateFilter();
  g.push("Erzählt mir mehr.");
  assert.equal(g.finish("Etwas ganz anderes."), "");
});

test("finish() speaks the whole reply when nothing was streamed", () => {
  const g = createGateFilter();
  assert.equal(g.finish("Hallo! [[dossier:no]]"), "Hallo!");
});

test("stripGates removes both gate kinds and collapses spaces", () => {
  assert.equal(stripGates("A [[dossier:yes]]  B [[ intake : end ]] "), "A B");
});
