import assert from "node:assert/strict";
import test from "node:test";

import { describePrivacy, flagEmoji } from "../../src/startup_voice/features/prefs/ui/privacy.js";

const by = (items, key) => items.find((i) => i.key === key);

test("everything in the browser: three green locks", () => {
  const items = describePrivacy({ prefs: { llm: "lfm3-1.7b", tts: "local", stt: "whisper", lang: "de" }, health: {}, hostname: "x.netlify.app" });
  assert.deepEqual(items.map((i) => [i.key, i.level, i.icon]), [["tts", "local", "lock"], ["stt", "local", "lock"], ["llm", "local", "lock"]]);
});

test("Scaleway (inside Europe) gets a yellow lock (not red), the browser speech API and ElevenLabs are red", () => {
  const items = describePrivacy({
    prefs: { llm: "ollama", tts: "elevenlabs", stt: "browser", lang: "de" },
    health: { llm_provider: "scaleway", llm_region: "FR" },
    hostname: "x.netlify.app",
  });
  assert.deepEqual([by(items, "llm").level, by(items, "llm").icon], ["eu", "lock"]);
  assert.match(by(items, "llm").text, /Scaleway.*Frankreich/);
  assert.deepEqual([by(items, "tts").level, by(items, "tts").icon], ["world", "🇺🇸"]);
  assert.deepEqual([by(items, "stt").level, by(items, "stt").icon], ["world", "🌐"]);
  assert.match(by(items, "stt").text, /Google/);
});

test("local Ollama is a green lock on a dev host, but not on a deployed URL", () => {
  const prefs = { llm: "ollama", tts: "local", stt: "whisper", lang: "de" };
  const health = { llm_provider: "ollama", llm_region: "LOCAL" };
  assert.equal(by(describePrivacy({ prefs, health, hostname: "localhost" }), "llm").level, "local");
  assert.equal(by(describePrivacy({ prefs, health, hostname: "x.netlify.app" }), "llm").level, "world");
});

test("an unknown server LLM region is red with a globe, a German host also gets the lock", () => {
  const prefs = { llm: "ollama", tts: "local", stt: "whisper", lang: "en" };
  const unknown = by(describePrivacy({ prefs, health: { llm_provider: "openai_compatible", llm_region: "" }, hostname: "x.app" }), "llm");
  assert.deepEqual([unknown.level, unknown.icon], ["world", "🌐"]);
  assert.match(unknown.text, /location unknown/);
  const de = by(describePrivacy({ prefs, health: { llm_provider: "openai_compatible", llm_region: "DE" }, hostname: "x.app" }), "llm");
  assert.deepEqual([de.level, de.icon], ["eu", "lock"]);
});

test("flagEmoji", () => {
  assert.equal(flagEmoji("fr"), "🇫🇷");
  assert.equal(flagEmoji(""), "🌐");
  assert.equal(flagEmoji("LOCAL"), "🌐");
});
