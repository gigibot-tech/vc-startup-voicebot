import assert from "node:assert/strict";
import test from "node:test";

import { applyAvailability, isDevHost, serverLlmOption } from "../../src/startup_voice/features/prefs/ui/availability.js";

const fakeDoc = (values) => {
  const opts = Object.fromEntries(values.map(([sel, text]) => [sel, { textContent: text, disabled: false, dataset: {} }]));
  return { opts, querySelector: (q) => opts[q] || null };
};

test("only local addresses are dev hosts", () => {
  for (const h of ["localhost", "127.0.0.1", "[::1]", "app.localhost"]) assert.equal(isDevHost(h), true, h);
  for (const h of ["startup-info-taker.netlify.app", "example.com", ""]) assert.equal(isDevHost(h), false, h);
});

test("Ollama is offered in dev, disabled on a deployed URL", () => {
  assert.equal(serverLlmOption({ provider: "ollama", dev: true }).disabled, false);
  assert.equal(serverLlmOption({ provider: "ollama", dev: false }).disabled, true);
  assert.match(serverLlmOption({ provider: "ollama", dev: false }).label, /nur lokal/);
});

test("a non-Ollama server LLM (Scaleway) stays usable on a deployed URL", () => {
  const o = serverLlmOption({ provider: "openai_compatible", model: "mistral-small", dev: false });
  assert.equal(o.disabled, false);
  assert.match(o.label, /Server-KI/);
});

test("Scaleway gets its own label; an unconfigured server LLM is disabled (fail fast)", () => {
  assert.match(serverLlmOption({ provider: "scaleway", model: "deepseek-v4.1-flash-1017", dev: false }).label, /^Scaleway · deepseek/);
  const none = serverLlmOption({ provider: "none", dev: false });
  assert.equal(none.disabled, true);
  assert.match(none.label, /nicht eingerichtet/);
  assert.doesNotMatch(serverLlmOption({ provider: "openai_compatible", dev: false }).label, /OpenAI/);
});

test("deployed without a server LLM: the reply model moves to the browser one", () => {
  const doc = fakeDoc([['#llmSel option[value="ollama"]', "Ollama"]]);
  const prefs = { llm: "ollama", lang: "de" };
  assert.equal(applyAvailability({ prefs, health: { llm_provider: "none" }, hostname: "x.netlify.app", doc }), true);
  assert.equal(prefs.llm, "lfm3-1.7b");
});

test("deployed + Ollama: the option is disabled and the reply model moves to the browser one", () => {
  const doc = fakeDoc([['#llmSel option[value="ollama"]', "Ollama"]]);
  const prefs = { llm: "ollama", lang: "de" };
  const changed = applyAvailability({ prefs, health: { llm_provider: "ollama" }, hostname: "x.netlify.app", doc });
  assert.equal(changed, true);
  assert.equal(prefs.llm, "lfm3-1.7b");
  assert.equal(doc.opts['#llmSel option[value="ollama"]'].disabled, true);
});

test("local dev keeps Ollama selected", () => {
  const doc = fakeDoc([['#llmSel option[value="ollama"]', "Ollama"]]);
  const prefs = { llm: "ollama", lang: "de" };
  assert.equal(applyAvailability({ prefs, health: { llm_provider: "ollama" }, hostname: "localhost", doc }), false);
  assert.equal(prefs.llm, "ollama");
});

test("cloud speech options that the server does not offer are disabled", () => {
  const doc = fakeDoc([['#sttSel option[value="elevenlabs"]', "ElevenLabs"], ['#sttSel option[value="deepgram"]', "Deepgram"]]);
  applyAvailability({ prefs: { llm: "lfm3-1.7b", lang: "de" }, health: { stt_providers: ["deepgram", "browser"] }, hostname: "localhost", doc });
  assert.equal(doc.opts['#sttSel option[value="elevenlabs"]'].disabled, true);
  assert.match(doc.opts['#sttSel option[value="elevenlabs"]'].textContent, /nicht verfügbar/);
  assert.equal(doc.opts['#sttSel option[value="deepgram"]'].disabled, false);
});
