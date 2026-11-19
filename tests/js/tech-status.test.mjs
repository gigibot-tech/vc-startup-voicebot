import assert from "node:assert/strict";
import test from "node:test";

import { describeLlm, describeModelBanner, describeStt } from "../../src/startup_voice/features/prefs/ui/tech-status.js";

test("a loading browser model says that talking still works", () => {
  const de = describeLlm({ llm: "granite-3b", state: "downloading", progress: 42, lang: "de" });
  assert.match(de, /42 %/);
  assert.match(de, /schon sprechen/);
  assert.match(describeLlm({ llm: "granite-3b", state: "downloading", progress: 42, lang: "en" }), /already talk/);
});

test("no model loaded yet: says so, and says speech recognition still works and another model can be picked", () => {
  const t = describeLlm({ llm: "granite-3b", state: "unloaded", lang: "de" });
  assert.match(t, /Noch kein Modell geladen/);
  assert.match(t, /Spracherkennung funktionieren trotzdem/);
  assert.match(t, /ein anderes/);
});

test("every model state has a sentence", () => {
  for (const state of ["unloaded", "checking_cache", "downloading", "warming_up", "cached_idle", "ready", "running", "error"]) {
    assert.ok(describeLlm({ llm: "gemma-3n-e2b", state, lang: "de" }).length > 20, state);
  }
});

test("a server model loads nothing in the browser", () => {
  assert.match(describeLlm({ llm: "ollama", lang: "de" }), /vom Server/);
});

test("STT line names the active engine", () => {
  assert.match(describeStt({ stt: "browser", lang: "de" }), /Browser \(Web Speech\)/);
  assert.match(describeStt({ stt: "whisper", state: "downloading", progress: 10, lang: "de" }), /10 %/);
  assert.match(describeStt({ stt: "whisper", state: "ready", lang: "en" }), /never leaves/);
  assert.match(describeStt({ stt: "elevenlabs", lang: "de" }), /ElevenLabs/);
});

test("banner: only while something loads, and it says which model", () => {
  assert.equal(describeModelBanner({ slot: "llm", state: "ready" }), null);
  assert.match(describeModelBanner({ slot: "llm", state: "downloading", progress: 5, lang: "de" }), /Antwort-KI lädt 5 %.*sprechen/);
  assert.match(describeModelBanner({ slot: "whisper", state: "downloading", progress: 5, lang: "de" }), /Spracherkennung/);
});
