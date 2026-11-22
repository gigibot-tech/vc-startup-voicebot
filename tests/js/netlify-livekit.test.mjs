// The Netlify function's LiveKit credential check + join token, against a fake LiveKit server.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

let handler;
try {
  ({ default: handler } = await import("../../netlify-app/netlify/functions/api.mjs"));
} catch (e) {
  test("netlify function deps not installed (run npm install in netlify-app)", { skip: true }, () => {});
}

const SECRET = "s".repeat(40);
process.env.LIVEKIT_WORKER = "external";
const verify = (jwt) => {
  const [h, p, sig] = jwt.split(".");
  const ok = createHmac("sha256", SECRET).update(`${h}.${p}`).digest("base64url") === sig;
  return { ok, claims: JSON.parse(Buffer.from(p, "base64url").toString()) };
};

async function withFakeLiveKit(status, run) {
  const seen = [];
  const server = createServer((req, res) => {
    const auth = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const v = verify(auth);
    seen.push({ url: req.url, ...v });
    res.statusCode = v.ok ? status : 401;
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { await run(`ws://127.0.0.1:${server.address().port}`, seen); } finally { server.close(); }
}

const call = async (path, init) => {
  const r = await handler(new Request(`http://x${path}`, init));
  return { status: r.status, body: await r.json() };
};

if (handler) {
  test("valid credentials: LiveKit accepts the signed ListRooms call", async () => {
    await withFakeLiveKit(200, async (url, seen) => {
      Object.assign(process.env, { LIVEKIT_URL: url, LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: SECRET });
      const { body } = await call("/api/voice/livekit-check");
      assert.equal(body.valid, true);
      assert.equal(seen[0].url, "/twirp/livekit.RoomService/ListRooms");
      assert.equal(seen[0].claims.iss, "APIkey");
      assert.equal(seen[0].claims.video.roomList, true);
      assert.ok(!JSON.stringify(body).includes(SECRET), "the secret is never returned");
    });
  });

  test("a wrong secret is reported as rejected and the mode is greyed out", async () => {
    await withFakeLiveKit(200, async (url) => {
      Object.assign(process.env, { LIVEKIT_URL: url, LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: "wrong-secret-wrong-secret" });
      const { body } = await call("/api/voice/livekit-check");
      assert.equal(body.valid, false);
      assert.equal(body.problem, "rejected");
      const t = (await call("/api/voice/transports")).body.transports.find((x) => x.name === "livekit");
      assert.equal(t.available, false);
      assert.match(t.reason, /rejected/);
    });
  });

  test("missing variables are named", async () => {
    Object.assign(process.env, { LIVEKIT_URL: "", LIVEKIT_API_KEY: "", LIVEKIT_API_SECRET: "" });
    const { body } = await call("/api/voice/livekit-check");
    assert.equal(body.problem, "missing");
    assert.match(body.hint, /LIVEKIT_API_SECRET/);
  });

  test("a URL that is not wss:// is flagged", async () => {
    Object.assign(process.env, { LIVEKIT_URL: "https://x.livekit.cloud", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: SECRET });
    assert.equal((await call("/api/voice/livekit-check")).body.problem, "url");
  });

  test("without a declared worker the live mode is not offered (it would time out)", async () => {
    await withFakeLiveKit(200, async (url) => {
      Object.assign(process.env, { LIVEKIT_URL: url, LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: SECRET });
      delete process.env.LIVEKIT_WORKER;
      await call("/api/voice/livekit-check"); // refresh the cached credential check (valid)
      const t = (await call("/api/voice/transports")).body.transports.find((x) => x.name === "livekit");
      assert.equal(t.available, false);
      assert.match(t.reason, /LIVEKIT_WORKER=external/);
      assert.deepEqual((await call("/health")).body.voice_modes, ["classic"]);
      assert.equal((await call("/api/voice/join", { method: "POST", body: JSON.stringify({ session_id: "x" }) })).status, 503);
      process.env.LIVEKIT_WORKER = "external";
      assert.deepEqual((await call("/health")).body.voice_modes, ["classic", "livekit"]);
      assert.equal((await call("/api/voice/transports")).body.transports.find((x) => x.name === "livekit").available, true);
    });
  });

  test("join mints a token LiveKit's verifier accepts, with the room grant", async () => {
    process.env.LIVEKIT_WORKER = "external";
    Object.assign(process.env, { LIVEKIT_URL: "wss://x.livekit.cloud", LIVEKIT_API_KEY: "APIkey", LIVEKIT_API_SECRET: SECRET });
    const created = await call("/api/sessions", { method: "POST", body: "{}" });
    const sid = created.body.session.id;
    const { status, body } = await call("/api/voice/join", {
      method: "POST", body: JSON.stringify({ mode: "livekit", session_id: sid, language: "de-DE", stt: "browser" }),
    });
    assert.equal(status, 200);
    const v = verify(body.token);
    assert.equal(v.ok, true);
    assert.equal(v.claims.iss, "APIkey");
    assert.equal(v.claims.video.room, body.room);
    assert.equal(v.claims.video.roomJoin, true);
    assert.equal(JSON.parse(v.claims.metadata).stt, "browser");
    assert.equal(JSON.parse(v.claims.metadata).language, "de");
    await call(`/api/sessions/${sid}`, { method: "DELETE" });
  });
}
