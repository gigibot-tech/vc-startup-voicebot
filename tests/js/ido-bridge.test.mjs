// Run: node --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { createIdoBridge } from "../../src/startup_voice/features/ido/ui/ido-bridge.js";

const IDEA = "123e4567-e89b-12d3-a456-426614174000";
const ORIGIN = "https://idoapp.eu";

function setup({ embedded = true, query = `?ido_origin=${ORIGIN}`, allowed = [ORIGIN], delta = [], sessionId = "s1" } = {}) {
  const posted = [];
  const listeners = [];
  const parentWin = { postMessage: (msg, target) => posted.push({ msg, target }) };
  const win = {
    location: { search: query },
    addEventListener: (type, fn) => listeners.push({ type, fn }),
  };
  win.parent = embedded ? parentWin : win;
  const notices = [];
  const calls = [];
  const state = { delta, notes: [] };
  const api = async (path) => {
    calls.push(path);
    if (path === "/api/ido/config") return { origins: allowed };
    return { session_id: sessionId, revision: "r", fields: state.delta, notes: state.notes };
  };
  const bridge = createIdoBridge({ api, getSessionId: () => sessionId, onNotice: (t) => notices.push(t), win, debounceMs: 5 });
  const send = (data, { source = parentWin, origin = ORIGIN } = {}) =>
    listeners.filter((l) => l.type === "message").forEach((l) => l.fn({ source, origin, data }));
  const fromParent = (d) => ({ source: "ido-core", v: 1, ...d });
  return { bridge, posted, notices, calls, state, send, fromParent, parentWin };
}
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const deltas = (t) => t.posted.filter((p) => p.msg.type === "dossier_delta");

test("opened on its own: the bridge does nothing and listens to nothing", async () => {
  const t = setup({ embedded: false });
  assert.equal(await t.bridge.start(), false);
  assert.deepEqual(t.posted, []);
  assert.deepEqual(t.calls, []);
});

test("embedded without ido_origin, or with an origin the server does not trust: inactive", async () => {
  assert.equal(await setup({ query: "" }).bridge.start(), false);
  const evil = setup({ query: "?ido_origin=https://evil.example", allowed: [ORIGIN] });
  assert.equal(await evil.bridge.start(), false);
  assert.deepEqual(evil.posted, []);
});

test("handshake: announces itself to the trusted origin only, never to '*'", async () => {
  const t = setup();
  assert.equal(await t.bridge.start(), true);
  assert.deepEqual(t.posted.map((p) => [p.msg.type, p.target]), [["ready", ORIGIN]]);
  assert.ok(t.posted.every((p) => p.target !== "*"));
});

test("init gives the idea; the current dossier is sent right away", async () => {
  const t = setup({ delta: [{ venture_key: "segments", value: "Gründerinnen", sources: ["market.target_icp"] }] });
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const [d] = deltas(t);
  assert.equal(d.target, ORIGIN);
  assert.deepEqual(d.msg.fields, [{ venture_key: "segments", value: "Gründerinnen" }]);
  assert.equal(d.msg.idea_id, IDEA);
  assert.equal(d.msg.session_id, "s1");
});

test("messages from the wrong origin, the wrong window, or with a wrong shape are ignored", async () => {
  const t = setup({ delta: [{ venture_key: "team", value: "x", sources: [] }] });
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }), { origin: "https://evil.example" });
  t.send(t.fromParent({ type: "init", idea_id: IDEA }), { source: { other: true } });
  t.send({ source: "someone", v: 1, type: "init", idea_id: IDEA });
  t.send({ source: "ido-core", v: 2, type: "init", idea_id: IDEA });
  t.send(t.fromParent({ type: "init", idea_id: "not-a-uuid" }));
  await tick();
  assert.equal(deltas(t).length, 0);
  assert.equal(t.bridge._state().ideaId, null);
});

test("only CHANGED fields are re-sent; a second identical flush sends nothing", async () => {
  const t = setup({ delta: [{ venture_key: "team", value: "Anna", sources: [] }] });
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const first = deltas(t)[0].msg;
  t.send(t.fromParent({ type: "delta_result", seq: first.seq, applied: ["team"], skipped: [] }));
  await t.bridge.flush();
  assert.equal(deltas(t).length, 1);
  t.state.delta = [{ venture_key: "team", value: "Anna und Ben", sources: [] }];
  await t.bridge.flush();
  assert.equal(deltas(t).length, 2);
  assert.deepEqual(deltas(t)[1].msg.fields, [{ venture_key: "team", value: "Anna und Ben" }]);
});

test("applied fields produce a notice; founder-written values are kept and explained once", async () => {
  const t = setup({ delta: [{ venture_key: "team", value: "A", sources: [] }, { venture_key: "market", value: "B", sources: [] }] });
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const { seq } = deltas(t)[0].msg;
  t.send(t.fromParent({ type: "delta_result", seq, applied: ["team"], skipped: [{ venture_key: "market", reason: "founder_value" }] }));
  assert.match(t.notices.at(-1), /1 Feld gespeichert/);
  assert.match(t.notices.at(-1), /1 Eintrag nicht überschrieben/);
  await t.bridge.flush(); // skipped value is final: no resend loop
  assert.equal(deltas(t).length, 1);
});

test("a failed write is retried on the next change, not forgotten", async () => {
  const t = setup({ delta: [{ venture_key: "team", value: "A", sources: [] }] });
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const { seq } = deltas(t)[0].msg;
  t.send(t.fromParent({ type: "delta_result", seq, applied: [], skipped: [{ venture_key: "team", reason: "error" }] }));
  await t.bridge.flush();
  assert.equal(deltas(t).length, 2);
});

test("state changes are debounced into one fetch", async () => {
  const t = setup({ delta: [{ venture_key: "team", value: "A", sources: [] }] });
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const before = t.calls.filter((c) => c.includes("ido-delta")).length;
  for (let i = 0; i < 5; i += 1) t.bridge.onStateChange();
  await tick(60);
  assert.equal(t.calls.filter((c) => c.includes("ido-delta")).length, before + 1);
});

test("a result for a sequence number we never sent is ignored", async () => {
  const t = setup();
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  t.send(t.fromParent({ type: "delta_result", seq: 99, applied: ["team"], skipped: [] }));
  assert.deepEqual(t.notices, []);
});


// ---------- note cards for the notetaking board -------------------------------------------

test("notes ride along with the delta; a notes-only change is still sent", async () => {
  const t = setup({ delta: [] });
  t.state.notes = [{ key: "team", body: "Gründer & Rollen: Anna" }];
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const [d] = deltas(t);
  assert.deepEqual(d.msg.notes, [{ key: "team", body: "Gründer & Rollen: Anna" }]);
  assert.deepEqual(d.msg.fields, []);
});

test("an unchanged card is not sent again; a changed one is, alone", async () => {
  const t = setup({ delta: [] });
  t.state.notes = [{ key: "team", body: "A" }, { key: "market", body: "B" }];
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const first = deltas(t)[0].msg;
  t.send(t.fromParent({ type: "delta_result", seq: first.seq, applied: [], skipped: [], notes_applied: ["team", "market"], notes_skipped: [] }));
  await t.bridge.flush();
  assert.equal(deltas(t).length, 1);
  t.state.notes = [{ key: "team", body: "A2" }, { key: "market", body: "B" }];
  await t.bridge.flush();
  assert.deepEqual(deltas(t)[1].msg.notes, [{ key: "team", body: "A2" }]);
});

test("card outcomes are explained: saved cards, and cards the founder edited are kept", async () => {
  const t = setup({ delta: [] });
  t.state.notes = [{ key: "team", body: "A" }, { key: "market", body: "B" }];
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const { seq } = deltas(t)[0].msg;
  t.send(t.fromParent({ type: "delta_result", seq, applied: [], skipped: [], notes_applied: ["team"], notes_skipped: [{ key: "market", reason: "founder_value" }] }));
  assert.match(t.notices.at(-1), /1 Karte auf dem Board gespeichert/);
  assert.match(t.notices.at(-1), /1 Eintrag nicht überschrieben/);
  await t.bridge.flush(); // both are final: no resend loop
  assert.equal(deltas(t).length, 1);
});

test("a card whose write failed is retried on the next change", async () => {
  const t = setup({ delta: [] });
  t.state.notes = [{ key: "team", body: "A" }];
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const { seq } = deltas(t)[0].msg;
  t.send(t.fromParent({ type: "delta_result", seq, applied: [], skipped: [], notes_applied: [], notes_skipped: [{ key: "team", reason: "error" }] }));
  await t.bridge.flush();
  assert.equal(deltas(t).length, 2);
});

test("an older ido-core that knows no notes (no notes_* in the result) still settles fields", async () => {
  const t = setup({ delta: [{ venture_key: "team", value: "A", sources: [] }] });
  await t.bridge.start();
  t.send(t.fromParent({ type: "init", idea_id: IDEA }));
  await tick();
  const { seq } = deltas(t)[0].msg;
  t.send(t.fromParent({ type: "delta_result", seq, applied: ["team"], skipped: [] }));
  assert.match(t.notices.at(-1), /1 Feld gespeichert/);
});
