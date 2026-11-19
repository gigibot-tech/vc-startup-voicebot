import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStore } from "@netlify/blobs";
import { PDFDocument, StandardFonts } from "pdf-lib";

const slots = ["team", "product", "traction", "market", "financing"];
const fields = {
  team: ["founders_roles", "background_expertise", "commitment_fulltime"],
  product: ["problem", "solution", "stage_status", "usp_tech"],
  traction: ["customers_pilots", "metrics_revenue", "growth_signal"],
  market: ["target_icp", "market_size", "competitors_moat"],
  financing: ["raise_amount_round", "use_of_funds", "runway_milestones"],
};
const labels = {
  team: "Team", product: "Produkt & Stand", traction: "Traktion",
  market: "Markt & Wettbewerb", financing: "Finanzierung",
};
const fieldLabels = {
  founders_roles: "Gründer & Rollen", background_expertise: "Hintergrund & Expertise",
  commitment_fulltime: "Zeitliche Verfügbarkeit", problem: "Problem", solution: "Lösung",
  stage_status: "Entwicklungsstand", usp_tech: "Alleinstellung & Tech",
  customers_pilots: "Kunden & Piloten", metrics_revenue: "Umsatz & Kennzahlen",
  growth_signal: "Wachstumssignal", target_icp: "Zielgruppe", market_size: "Marktgröße",
  competitors_moat: "Wettbewerb & Vorsprung", raise_amount_round: "Finanzierungsrunde",
  use_of_funds: "Mittelverwendung", runway_milestones: "Runway & Meilensteine",
};
const defaults = {
  greeting: "Willkommen. Ich führe mit dir ein strukturiertes Erstgespräch zu Team, Produkt, Traktion, Markt und Finanzierung. Was baut ihr gerade?",
  reply_system_prompt: "Du bist ein präziser, freundlicher Analyst für ein erstes Startup-Gespräch. Antworte kurz in der Sprache des Gründers. Würdige neue Angaben und stelle höchstens zwei konkrete, offene Fragen zu den noch fehlenden Punkten. Erfinde keine Fakten.",
  slot_questions: {
    team: "Wer gründet mit, welche Rollen habt ihr und welche relevante Erfahrung bringt ihr mit?",
    product: "Welches Problem löst ihr, wie funktioniert eure Lösung und wie weit ist das Produkt?",
    traction: "Wer nutzt oder testet das Produkt bereits und welche messbaren Ergebnisse habt ihr?",
    market: "Wer ist eure genaue Zielgruppe, wie groß ist der Markt und wer sind die Alternativen?",
    financing: "Welche Runde plant ihr, wie viel Kapital braucht ihr und wofür?",
  },
  followup_mode: "balanced", extract_mode: "full",
};
const here = dirname(fileURLToPath(import.meta.url));
const localRoot = resolve(here, "../../.local-data");
const isNetlify = process.env.NETLIFY === "true";
const sessionBlobs = isNetlify ? getStore({ name: "startup-voice-sessions", region: "eu-central-1" }) : null;
const configBlobs = isNetlify ? getStore({ name: "startup-voice-config", region: "eu-central-1" }) : null;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
function error(message, status = 400) { return json({ detail: message }, status); }
function emptyObject(slot) {
  return { slot, fields: Object.fromEntries(fields[slot].map((f) => [f, ""])), pending: {}, summary: "", evidence: [], missing_or_vague: [...fields[slot]], status: "open", belege: 0, updated_at_turn: 0 };
}
function blankSession(language = "de") {
  return { id: randomBytes(6).toString("hex"), created_at: new Date().toISOString(), language: /^en/i.test(language) ? "en" : "de", followup_mode: "balanced", objects: Object.fromEntries(slots.map((s) => [s, emptyObject(s)])), messages: [], turn_index: 0, finalized: false, spoken_summary: "", evaluation: { field_coverage: 0, evidence_specificity: 0, status: "open", missing_fields: slots.flatMap((s) => fields[s].map((f) => `${s}.${f}`)), next_focus_slot: "team", next_focus_slots: [...slots], ready_for_closing: false, slot_coverage: Object.fromEntries(slots.map((s) => [s, 0])), slot_specificity: Object.fromEntries(slots.map((s) => [s, 0])) }, conflict_history: [], dossier_versions: [] };
}
function evaluate(session) {
  const slotCoverage = {}, slotSpecificity = {}, missing = [];
  let totalCoverage = 0, totalSpecificity = 0;
  for (const slot of slots) {
    const obj = session.objects[slot] ||= emptyObject(slot);
    const absent = fields[slot].filter((f) => !String(obj.fields?.[f] || "").trim());
    const cov = (fields[slot].length - absent.length) / fields[slot].length;
    const spec = cov === 1 ? Math.max(Number(obj.belege || 0), 0.5) : Number(obj.belege || 0);
    obj.missing_or_vague = absent;
    obj.status = cov >= 0.67 && spec >= 0.34 && absent.length === 0 ? "solid" : (cov > 0 || obj.summary || obj.evidence?.length ? "partial" : "open");
    slotCoverage[slot] = Number(cov.toFixed(3)); slotSpecificity[slot] = Number(spec.toFixed(3));
    totalCoverage += cov; totalSpecificity += spec;
    missing.push(...absent.map((f) => `${slot}.${f}`));
  }
  const focus = slots.filter((s) => session.objects[s].status !== "solid").sort((a, b) => slotCoverage[a] - slotCoverage[b]);
  const ready = focus.length === 0;
  session.evaluation = { field_coverage: Number((totalCoverage / slots.length).toFixed(3)), evidence_specificity: Number((totalSpecificity / slots.length).toFixed(3)), status: ready ? "solid" : (totalCoverage ? "partial" : "open"), missing_fields: missing, next_focus_slot: focus[0] || null, next_focus_slots: focus, ready_for_closing: ready, slot_coverage: slotCoverage, slot_specificity: slotSpecificity };
  return session.evaluation;
}
const sessionKey = (id) => `sessions/${id}.json`;
async function localRead(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
async function localWrite(file, value) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value), "utf8"); }
async function loadSession(id) {
  const s = isNetlify ? await sessionBlobs.get(sessionKey(id), { type: "json", consistency: "strong" }) : await localRead(resolve(localRoot, sessionKey(id)));
  if (!s) throw Object.assign(new Error(`Session not found: ${id}`), { status: 404 });
  return s;
}
async function saveSession(session) {
  if (isNetlify) await sessionBlobs.setJSON(sessionKey(session.id), session);
  else await localWrite(resolve(localRoot, sessionKey(session.id)), session);
}
async function listSessions() {
  let all;
  if (isNetlify) {
    const { blobs } = await sessionBlobs.list({ prefix: "sessions/" });
    all = await Promise.all(blobs.filter((b) => /^sessions\/[a-f0-9]+\.json$/i.test(b.key)).map((b) => sessionBlobs.get(b.key, { type: "json", consistency: "strong" })));
  } else {
    const dir = resolve(localRoot, "sessions");
    let names = []; try { names = await readdir(dir); } catch (e) { if (e.code !== "ENOENT") throw e; }
    all = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => localRead(resolve(dir, n))));
  }
  return all.filter(Boolean).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map((s) => {
    const preview = [...(s.messages || [])].reverse().find((m) => m.role === "user")?.content?.slice(0, 72) || "—";
    return { id: s.id, created_at: s.created_at, turn_index: s.turn_index, finalized: s.finalized, ready_for_closing: s.evaluation?.ready_for_closing || false, complete: Boolean(s.finalized && s.evaluation?.ready_for_closing), field_coverage: s.evaluation?.field_coverage || 0, preview };
  });
}
async function deleteSession(id) {
  if (isNetlify) await sessionBlobs.delete(sessionKey(id));
  else await rm(resolve(localRoot, sessionKey(id)), { force: true });
}
async function loadConfig() {
  const cfg = isNetlify ? await configBlobs.get("interview-config.json", { type: "json", consistency: "strong" }) : await localRead(resolve(localRoot, "interview-config.json"));
  return { ...defaults, ...(cfg || {}), slot_questions: { ...defaults.slot_questions, ...(cfg?.slot_questions || {}) } };
}
async function saveConfig(cfg) {
  const normalized = { ...defaults, ...cfg, slot_questions: { ...defaults.slot_questions, ...(cfg.slot_questions || {}) } };
  if (isNetlify) await configBlobs.setJSON("interview-config.json", normalized);
  else await localWrite(resolve(localRoot, "interview-config.json"), normalized);
  return normalized;
}
function normPath(path) { return decodeURIComponent(path).replace(/\/+$/, "") || "/"; }
function promptFor(session, text, cfg) {
  const ev = session.evaluation || evaluate(session);
  const focus = ev.next_focus_slot || "team";
  const gaps = ev.missing_fields.length ? ev.missing_fields.map((x) => `- ${x}`).join("\n") : "Keine Pflichtfelder offen.";
  const transcript = (session.messages || []).slice(-8).map((m) => `${m.role}: ${m.content}`).join("\n");
  const language = session.language === "en" ? "English" : "German";
  const system = `${cfg.reply_system_prompt}\nReply in ${language}. Current area: ${labels[focus]}. Next suggested question: ${cfg.slot_questions[focus]}. Do not invent facts. Keep the response brief.`;
  const user = `Founder just said: ${text}\n\nOpen dossier fields:\n${gaps}\n\nRecent conversation:\n${transcript}\n\nAcknowledge their answer and ask one useful follow-up about an open field. If there are no open fields, offer to wrap up.`;
  return { system, user, focus };
}
const extractSystem = `You extract startup facts from a founder conversation. Return only valid JSON with shape {"updates":{"team":{"fields":{},"summary":"","evidence":[]},"product":{},"traction":{},"market":{},"financing":{}},"belege":{"team":0,"product":0,"traction":0,"market":0,"financing":0}}. Use only facts explicitly stated by the founder. Leave unknown fields empty. Each belege score is 0 to 1 and measures concrete evidence.`;
function extractUser(session, latest) {
  return `Conversation language: ${session.language}. Latest founder statement: ${latest}\n\nFull founder transcript:\n${(session.messages || []).filter((m) => m.role === "user").map((m) => m.content).join("\n")}\n\nCurrent dossier:\n${JSON.stringify(session.objects)}`;
}
function responseText(data) { return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || ""; }
async function complete(system, user, { jsonMode = false, maxTokens = 900 } = {}) {
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw Object.assign(new Error("Set LLM_API_KEY (or OPENAI_API_KEY) in Netlify environment variables."), { status: 503 });
  const base = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model, max_tokens: maxTokens, ...(jsonMode ? { response_format: { type: "json_object" } } : {}), messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
  if (!res.ok) throw new Error(`LLM provider returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return responseText(await res.json()).trim();
}
async function* streamCompletion(system, user) {
  const key = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY;
  if (!key) throw Object.assign(new Error("Set LLM_API_KEY (or OPENAI_API_KEY) in Netlify environment variables."), { status: 503 });
  const base = (process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: process.env.LLM_MODEL || "gpt-4o-mini", stream: true, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
  if (!res.ok) throw new Error(`LLM provider returned ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n"); buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim(); if (data === "[DONE]") return;
      try { const piece = JSON.parse(data)?.choices?.[0]?.delta?.content; if (piece) yield piece; } catch { /* ignore SSE comments/partial JSON */ }
    }
    if (done) break;
  }
}
function sse(event, data) { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; }
function stripMarkers(value) { return String(value || "").replace(/\s*\[\[\s*(?:dossier\s*:\s*(?:yes|no)|intake\s*:\s*end)\s*\]\]\s*$/i, "").trim(); }
function parseJson(raw) { const text = String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); try { return JSON.parse(text); } catch { const start = text.indexOf("{"); const end = text.lastIndexOf("}"); return start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : {}; } }
function mergeExtract(session, result) {
  const updates = result?.updates || result?.slots || {};
  for (const slot of slots) {
    const patch = updates[slot]; if (!patch || typeof patch !== "object") continue;
    const obj = session.objects[slot], newFields = patch.fields || patch;
    for (const field of fields[slot]) {
      const next = String(newFields[field] || "").trim(); if (!next) continue;
      const old = String(obj.fields[field] || "").trim();
      if (!old || old.toLocaleLowerCase() === next.toLocaleLowerCase()) obj.fields[field] = next;
      else obj.pending[field] = { old, new: next, source: "chat", quote: "", page: null, turn: session.turn_index, confidence: Number(patch.confidence?.[field] ?? 0.5) };
    }
    if (patch.summary) obj.summary = String(patch.summary).slice(0, 800);
    const evidence = Array.isArray(patch.evidence) ? patch.evidence : patch.evidence ? [patch.evidence] : [];
    obj.evidence = [...new Set([...(obj.evidence || []), ...evidence.map(String).filter(Boolean)])];
    obj.updated_at_turn = session.turn_index;
    const belege = result?.belege?.[slot]; if (Number.isFinite(Number(belege))) obj.belege = Math.max(0, Math.min(1, Number(belege)));
  }
  evaluate(session);
}
async function saveDownload(session, type) {
  if (type === "json") return new Response(JSON.stringify(session, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${session.id}.json"` } });
  if (type === "md") {
    const lines = [`# Startup Erstgespräch`, ``, `_Session ${session.id} · ${session.created_at}_`, ``, `## Kurzfazit`, ``, session.spoken_summary || "_Noch keine Zusammenfassung._", "", "## Dimensionen", ""];
    for (const slot of slots) { const obj = session.objects[slot]; lines.push(`### ${labels[slot]} — ${obj.status}`, ""); if (obj.summary) lines.push(obj.summary, ""); for (const [k, v] of Object.entries(obj.fields)) lines.push(`- **${fieldLabels[k] || k}:** ${v || "—"}`); lines.push(""); }
    return new Response(`${lines.join("\n").trim()}\n`, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="dossier-${session.id}.md"` } });
  }
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const width = 515, margin = 42, lineHeight = 15;
  let page = pdf.addPage([595, 842]), y = 795;
  const newPage = () => { page = pdf.addPage([595, 842]); y = 795; };
  const write = (text, { size = 10, strong = false, gap = 0 } = {}) => {
    const chosen = strong ? bold : font;
    const max = Math.max(22, Math.floor(width / (size * 0.53)));
    const parts = String(text || "").split("\n").flatMap((line) => {
      if (!line) return [""];
      const out = []; let current = "";
      for (const word of line.split(/\s+/)) {
        const next = current ? `${current} ${word}` : word;
        if (next.length > max && current) { out.push(current); current = word; } else current = next;
      }
      if (current) out.push(current);
      return out;
    });
    for (const part of parts) {
      if (y < 48) newPage();
      if (part) page.drawText(part, { x: margin, y, size, font: chosen, maxWidth: width });
      y -= lineHeight;
    }
    y -= gap;
  };
  write("Startup Erstgespräch", { size: 20, strong: true, gap: 6 });
  write(`Session ${session.id} · ${session.created_at}`, { size: 9, gap: 12 });
  write("Kurzfazit", { size: 14, strong: true, gap: 3 });
  write(session.spoken_summary || "Noch keine Zusammenfassung.", { gap: 12 });
  for (const slot of slots) {
    const obj = session.objects[slot];
    write(`${labels[slot]} — ${obj.status}`, { size: 14, strong: true, gap: 3 });
    if (obj.summary) write(obj.summary, { gap: 2 });
    for (const [key, value] of Object.entries(obj.fields)) write(`${fieldLabels[key] || key}: ${value || "—"}`);
    write("", { gap: 5 });
  }
  return new Response(await pdf.save(), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="dossier-${session.id}.pdf"` } });
}
async function streamTurn(id, body) {
  if (!String(body.text || "").trim()) return error("text is required");
  const session = await loadSession(id), text = String(body.text).trim(), cfg = await loadConfig();
  session.messages.push({ role: "user", content: text, ts: new Date().toISOString(), warning: "" });
  session.turn_index += 1;
  const { system, user } = promptFor(session, text, cfg);
  const stream = new ReadableStream({
    async start(controller) {
      const send = (name, data) => controller.enqueue(new TextEncoder().encode(sse(name, data)));
      let reply = "";
      try {
        send("status", { phase: "reply", message: "Thinking…" });
        for await (const chunk of streamCompletion(system, user)) { reply += chunk; send("delta", { text: chunk }); }
        reply = stripMarkers(reply);
        if (!reply) throw new Error("LLM returned an empty reply");
        session.messages.push({ role: "assistant", content: reply, ts: new Date().toISOString(), warning: "" });
        evaluate(session); await saveSession(session);
        send("reply", { reply, session, needs_extract: true, offer_end: session.evaluation.ready_for_closing });
        send("status", { phase: "extract", message: "Updating dossier…" });
        const extracted = await complete(extractSystem, extractUser(session, text), { jsonMode: true, maxTokens: 1300 });
        mergeExtract(session, parseJson(extracted));
        await saveSession(session);
        send("done", { session, reply, needs_extract: true, offer_end: session.evaluation.ready_for_closing || session.evaluation.field_coverage >= 1 });
      } catch (e) { send("error", { message: `LLM turn failed: ${e.message}` }); }
      finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" } });
}
function schemaResponse() {
  return { slots: slots.map((slot) => ({ id: slot, label: labels[slot], fields: fields[slot].map((id) => ({ id, label: fieldLabels[id] })) })), status_labels: { open: "Offen", partial: "In Arbeit", solid: "Belastbar" } };
}
function markdownDossier(session) { return saveDownload(session, "md"); }

export default async function handler(request) {
  const url = new URL(request.url), path = normPath(url.pathname), method = request.method.toUpperCase();
  try {
    if (path === "/health" && method === "GET") {
      const sessions = await listSessions();
      const speechReady = Boolean(process.env.ELEVENLABS_API_KEY);
      return json({ ok: true, sessions: sessions.length, data_dir: "Netlify Blobs (Frankfurt)", tts: speechReady ? "elevenlabs" : "missing_key", stt: speechReady ? "elevenlabs" : "browser", stt_providers: speechReady ? ["elevenlabs"] : [], voice_settings: {}, voice_modes: ["classic"], voice_mode: "classic" });
    }
    if (path === "/api/dossier-schema" && method === "GET") return json(schemaResponse());
    if (path === "/api/ido/config" && method === "GET") return json({ origins: String(process.env.IDO_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean) });
    if (path === "/api/voice/transports" && method === "GET") return json({ default: "classic", transports: [{ id: "classic", available: true }] });
    if (path === "/api/voice/preflight" && method === "POST") {
      const body = await request.json().catch(() => ({})), hasKey = Boolean(process.env.ELEVENLABS_API_KEY), want = body.stt === "browser" ? "browser" : (hasKey ? "elevenlabs" : "browser");
      const stt = { ok: want === "browser" || hasKey, provider: want, fallback: want === "browser" ? "browser" : undefined, errors: [] };
      const tts = body.check_tts === false ? { ok: true, provider: null, errors: [], skipped: true } : { ok: hasKey && Boolean(process.env.ELEVENLABS_VOICE_ID), provider: "elevenlabs", errors: hasKey && process.env.ELEVENLABS_VOICE_ID ? [] : ["Configure ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID"] };
      return json({ ok: true, stt, tts, mic: { ok: true, use: want } });
    }
    if (path === "/api/tts" && method === "POST") {
      const b = await request.json(), key = process.env.ELEVENLABS_API_KEY, voice = process.env.ELEVENLABS_VOICE_ID;
      if (!key || !voice) return error("Speech output is unavailable: configure ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID.", 503);
      const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/stream`, { method: "POST", headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" }, body: JSON.stringify({ text: String(b.text || "").slice(0, 4000), model_id: process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2", voice_settings: { stability: b.stability ?? 0.5, similarity_boost: b.similarity ?? 0.75, style: b.style ?? 0, speed: b.speed ?? 1 } }) });
      if (!upstream.ok) return error(`TTS provider returned ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`, 502);
      return new Response(upstream.body, { headers: { "content-type": "audio/mpeg" } });
    }
    if (path === "/api/stt" && method === "POST") {
      const key = process.env.ELEVENLABS_API_KEY;
      if (!key) return error("Cloud speech recognition is not configured. Select browser speech recognition or add ELEVENLABS_API_KEY.", 503);
      const form = await request.formData(), audio = form.get("audio");
      if (!audio || typeof audio.arrayBuffer !== "function" || audio.size === 0) return error("empty audio");
      const upstreamForm = new FormData();
      upstreamForm.set("file", audio, audio.name || "recording.webm");
      upstreamForm.set("model_id", "scribe_v1");
      const language = String(form.get("language") || "").slice(0, 2).toLowerCase();
      if (["de", "en"].includes(language)) upstreamForm.set("language_code", language);
      const upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": key }, body: upstreamForm });
      if (!upstream.ok) return error(`Speech recognition returned ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`, 502);
      const result = await upstream.json();
      return json({ text: result.text || "", provider: "elevenlabs", errors: [] });
    }
    if (path === "/api/sessions" && method === "GET") return json({ sessions: await listSessions() });
    if (path === "/api/sessions" && method === "POST") {
      const body = await request.json().catch(() => ({})), session = blankSession(body.language || "de"), cfg = await loadConfig();
      session.messages.push({ role: "assistant", content: cfg.greeting, ts: new Date().toISOString(), warning: "" });
      await saveSession(session); return json({ session, reply: cfg.greeting }, 201);
    }
    if (path === "/api/interview-config" && method === "GET") return json(await loadConfig());
    if (path === "/api/interview-config" && method === "PUT") return json(await saveConfig(await request.json()));
    if (path === "/api/interview-config/reset" && method === "POST") { if (isNetlify) await configBlobs.delete("interview-config.json"); else await rm(resolve(localRoot, "interview-config.json"), { force: true }); return json(defaults); }
    let m = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && method === "GET") return json(await loadSession(m[1]));
    if (m && method === "PATCH") { const s = await loadSession(m[1]), b = await request.json(); if (b.language) s.language = /^en/i.test(b.language) ? "en" : "de"; if (b.followup_mode) s.followup_mode = ["balanced", "insist", "strict"].includes(b.followup_mode) ? b.followup_mode : "balanced"; await saveSession(s); return json(s); }
    if (m && method === "DELETE") { await loadSession(m[1]); await deleteSession(m[1]); return json({ ok: true, deleted: m[1] }); }
    m = path.match(/^\/api\/sessions\/([^/]+)\/turn\/stream$/);
    if (m && method === "POST") return await streamTurn(m[1], await request.json());
    m = path.match(/^\/api\/sessions\/([^/]+)\/turn$/);
    if (m && method === "POST") {
      const b = await request.json();
      const streamed = await streamTurn(m[1], b); const reader = streamed.body.getReader(); const dec = new TextDecoder(); let buf = "", donePayload;
      while (true) { const x = await reader.read(); buf += dec.decode(x.value || new Uint8Array(), { stream: !x.done }); if (x.done) break; const parts = buf.split("\n\n"); buf = parts.pop() || ""; for (const block of parts) if (block.startsWith("event: done")) donePayload = JSON.parse(block.split("\ndata: ")[1]); }
      return donePayload ? json(donePayload) : error("LLM turn failed", 502);
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/turn\/prepare$/);
    if (m && method === "POST") {
      const s = await loadSession(m[1]), b = await request.json(), cfg = await loadConfig(); s.messages.push({ role: "user", content: String(b.text || ""), ts: new Date().toISOString(), warning: "" }); s.turn_index += 1; evaluate(s); await saveSession(s);
      const p = promptFor(s, b.text, cfg); return json({ session: s, reply_system: p.system, reply_user: p.user, extract_system: extractSystem, extract_user: extractUser(s, b.text), reply_max_tokens: 500, extract_max_tokens: 1300 });
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/turn\/reply$/);
    if (m && method === "POST") { const s = await loadSession(m[1]), b = await request.json(), reply = stripMarkers(b.raw_reply); s.messages.push({ role: "assistant", content: reply, ts: new Date().toISOString(), warning: "" }); await saveSession(s); return json({ session: s, reply, needs_extract: true, offer_end: s.evaluation?.ready_for_closing || false }); }
    m = path.match(/^\/api\/sessions\/([^/]+)\/turn\/commit$/);
    if (m && method === "POST") { const s = await loadSession(m[1]), b = await request.json(); if (b.raw_reply && s.messages.at(-1)?.role !== "assistant") s.messages.push({ role: "assistant", content: stripMarkers(b.raw_reply), ts: new Date().toISOString(), warning: "" }); mergeExtract(s, parseJson(b.raw_extract)); await saveSession(s); return json({ session: s, reply: s.messages.at(-1)?.content || "", needs_extract: true, offer_end: s.evaluation.ready_for_closing || s.evaluation.field_coverage >= 1 }); }
    m = path.match(/^\/api\/sessions\/([^/]+)\/continue(?:\/prepare|\/commit)?$/);
    if (m && method === "POST") { const s = await loadSession(m[1]), cfg = await loadConfig(), focus = s.evaluation?.next_focus_slot || "team", question = cfg.slot_questions[focus]; if (path.endsWith("/prepare")) return json({ reply_system: cfg.reply_system_prompt, reply_user: `In ${s.language === "en" ? "English" : "German"}, ask one short follow-up question about ${labels[focus]}. The question to use as a guide is: ${question}`, reply_max_tokens: 180 }); if (path.endsWith("/commit")) { const b = await request.json(); s.messages.push({ role: "assistant", content: stripMarkers(b.raw_reply), ts: new Date().toISOString(), warning: "" }); await saveSession(s); return json({ session: s, reply: s.messages.at(-1).content }); } s.messages.push({ role: "assistant", content: question, ts: new Date().toISOString(), warning: "" }); await saveSession(s); return json({ session: s, reply: question }); }
    m = path.match(/^\/api\/sessions\/([^/]+)\/extract(?:\/(prepare|commit))?$/);
    if (m && method === "POST") { const s = await loadSession(m[1]); if (m[1] && path.endsWith("/prepare")) return json({ focus: s.evaluation?.next_focus_slot || "team", extract_system: extractSystem, extract_user: extractUser(s, ""), extract_max_tokens: 1300 }); const b = m[2] === "commit" ? await request.json() : null; const raw = b?.raw_extract ?? await complete(extractSystem, extractUser(s, ""), { jsonMode: true, maxTokens: 1300 }); mergeExtract(s, parseJson(raw)); await saveSession(s); return json({ session: s, offer_end: s.evaluation.ready_for_closing || s.evaluation.field_coverage >= 1 }); }
    m = path.match(/^\/api\/sessions\/([^/]+)\/finalize$/);
    if (m && method === "POST") { const s = await loadSession(m[1]); evaluate(s); const prompt = `Write a concise ${s.language === "en" ? "English" : "German"} spoken summary of this startup interview. Do not invent facts.\n${JSON.stringify(s.objects)}`; const summary = await complete("You are a startup analyst. Give a balanced, evidence-based wrap-up.", prompt, { maxTokens: 500 }); s.finalized = true; s.spoken_summary = summary; s.messages.push({ role: "assistant", content: summary, ts: new Date().toISOString(), warning: "" }); const now = new Date(), id = `v${String(s.dossier_versions.length + 1).padStart(2, "0")}_${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`; s.dossier_versions.push({ version: s.dossier_versions.length + 1, id, created_at: now.toISOString(), turn_index: s.turn_index, field_coverage: s.evaluation.field_coverage, evidence_specificity: s.evaluation.evidence_specificity, ready_for_closing: s.evaluation.ready_for_closing, spoken_summary: summary }); await saveSession(s); return json({ session: s, reply: summary }); }
    m = path.match(/^\/api\/sessions\/([^/]+)\/clear$/);
    if (m && method === "POST") { const s = await loadSession(m[1]); for (const slot of slots) s.objects[slot] = emptyObject(slot); s.finalized = false; s.spoken_summary = ""; s.dossier_versions = []; evaluate(s); await saveSession(s); return json({ session: s }); }
    m = path.match(/^\/api\/sessions\/([^/]+)\/dossier\/resolve$/);
    if (m && method === "POST") {
      const s = await loadSession(m[1]), b = await request.json();
      for (const d of b.decisions || []) { const obj = s.objects[d.slot], pending = obj?.pending?.[d.field]; if (!pending) continue; let val; if (d.choice === "new") val = pending.new; else if (d.choice === "manual") val = String(d.manual_text || "").trim(); else val = pending.old; if (d.choice === "manual" && !val) return error("Manual text cannot be empty."); obj.fields[d.field] = val; delete obj.pending[d.field]; s.conflict_history.push({ slot: d.slot, field: d.field, choice: d.choice, old: pending.old, new: pending.new, confidence: pending.confidence, source: pending.source, at: new Date().toISOString(), auto: Boolean(d.auto) }); }
      evaluate(s); await saveSession(s); return json({ session: s });
    }
    m = path.match(/^\/api\/sessions\/([^/]+)\/dossier\.(md|pdf)$/);
    if (m && method === "GET") { const s = await loadSession(m[1]); return await saveDownload(s, m[2]); }
    m = path.match(/^\/api\/sessions\/([^/]+)\/dossiers\/([^/]+)\.(md|json|pdf)$/);
    if (m && method === "GET") { const s = await loadSession(m[1]); if (m[3] === "json") return json(s); if (m[3] === "md") return await saveDownload(s, "md"); return await saveDownload(s, "pdf"); }
    m = path.match(/^\/api\/sessions\/([^/]+)\/ido-delta$/);
    if (m && method === "GET") {
      const s = await loadSession(m[1]);
      const ventureMap = [
        ["team", ["founders_roles", "background_expertise", "commitment_fulltime"]], ["product", ["problem", "solution", "stage_status", "usp_tech"]],
        ["traction", ["customers_pilots", "metrics_revenue", "growth_signal"]], ["market", ["target_icp", "market_size", "competitors_moat"]], ["financing", ["raise_amount_round", "use_of_funds", "runway_milestones"]],
      ];
      const fieldsOut = ventureMap.flatMap(([slot, fs]) => { const present = fs.filter((f) => s.objects[slot].fields[f]); return present.length ? [{ venture_key: slot, value: present.map((f) => `${fieldLabels[f]}: ${s.objects[slot].fields[f]}`).join("\n"), sources: present.map((f) => `${slot}.${f}`) }] : []; });
      const notes = slots.flatMap((slot) => { const lines = fields[slot].filter((f) => s.objects[slot].fields[f]).map((f) => `${fieldLabels[f]}: ${s.objects[slot].fields[f]}`); return lines.length ? [{ key: slot, body: lines.join("\n") }] : []; });
      const content = JSON.stringify({ fields: fieldsOut, notes }); let hash = 0; for (const c of content) hash = ((hash << 5) - hash + c.charCodeAt(0)) | 0;
      return json({ session_id: s.id, revision: Math.abs(hash).toString(16), fields: fieldsOut, notes });
    }
    if (path === "/api/debug/data-dir" && method === "GET") return json({ data_dir: "Netlify Blobs (Frankfurt)", sessions: (await listSessions()).length, default: "Netlify Blobs" });
    return error("Not found", 404);
  } catch (e) {
    console.error("Netlify app request failed", e);
    return error(e.message || "Internal server error", e.status || 500);
  }
}
