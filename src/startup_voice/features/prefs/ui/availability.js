/**
 * What the Settings dropdowns may offer, from the server's /health and where the app runs.
 *
 *  - Ollama is a local developer tool: on a deployed URL its option is disabled and the reply model
 *    falls back to the browser (WebGPU) model. A server LLM that is NOT Ollama (Scaleway, OpenAI,
 *    any OpenAI-compatible endpoint) keeps working everywhere: it uses the same "server" option.
 *  - A cloud speech provider that is not configured / out of credits is disabled, not offered.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const isDevHost = (hostname) => {
  const h = String(hostname || "").toLowerCase();
  return LOCAL_HOSTS.has(h) || h.endsWith(".localhost");
};

/** The "server" reply-model option: label + whether it can be used here. */
export function serverLlmOption({ provider, model, dev, lang = "de" }) {
  const de = String(lang).startsWith("de");
  const p = String(provider || "ollama").toLowerCase();
  if (p === "ollama") {
    return dev
      ? { label: `Ollama (${de ? "lokal" : "local"} · ${model || "Granite 4.2 8B"})`, disabled: false }
      : { label: `Ollama (${de ? "nur lokal" : "local only"})`, disabled: true };
  }
  const name = p === "openai_compatible" || p === "vllm" ? (de ? "Server-KI" : "Server AI") : "OpenAI";
  return { label: `${name}${model ? ` · ${model}` : ""}`, disabled: false };
}

export const BROWSER_LLM_DEFAULT = "granite-3b";

/**
 * Apply the rules to the page and to prefs. Returns true when prefs changed (caller saves + repaints).
 * @param {{prefs: object, health: object, hostname: string, doc?: Document}} o
 */
export function applyAvailability({ prefs, health, hostname, doc = globalThis.document }) {
  let changed = false;
  const dev = isDevHost(hostname);
  const llm = serverLlmOption({
    provider: health?.llm_provider, model: health?.llm_model, dev, lang: prefs.lang || "de",
  });
  const llmOpt = doc?.querySelector?.('#llmSel option[value="ollama"]');
  if (llmOpt) { llmOpt.textContent = llm.label; llmOpt.disabled = llm.disabled; }
  if (llm.disabled && prefs.llm === "ollama") { prefs.llm = BROWSER_LLM_DEFAULT; changed = true; }

  const providers = Array.isArray(health?.stt_providers) ? health.stt_providers : [];
  for (const value of ["elevenlabs", "deepgram"]) {
    const opt = doc?.querySelector?.(`#sttSel option[value="${value}"]`);
    if (!opt) continue;
    const ok = providers.includes(value);
    opt.disabled = !ok;
    opt.dataset.label ??= opt.textContent;
    opt.textContent = ok ? opt.dataset.label : `${opt.dataset.label} (${String(prefs.lang || "de").startsWith("de") ? "nicht verfügbar" : "unavailable"})`;
  }
  return changed;
}
