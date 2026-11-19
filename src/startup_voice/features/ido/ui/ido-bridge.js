/**
 * Bridge to ido-core when this app runs inside its iframe (idea page -> "Gespräch" tab).
 *
 *   voice app (iframe)                              ido-core (parent page)
 *   ──────────────────                              ──────────────────────
 *   ready  ─────────────────────────────────────►
 *          ◄───────────────────────────────────── init {idea_id}
 *   dossier changed -> GET /api/sessions/{id}/ido-delta
 *   dossier_delta {seq, fields:[{venture_key,value}], notes:[{key,body}]} ─►
 *        applyIntakeDelta -> apply_venture_field_change  +  applyIntakeNotes -> cards on the notes board
 *          ◄───────────────────────────────────── delta_result {seq, applied, skipped, notes_applied, notes_skipped}
 *
 * Trust rules (both sides enforce them):
 *  - messages are accepted only from window.parent AND from one origin that BOTH the server
 *    (IDO_ORIGINS via /api/ido/config) and this page's `ido_origin` parameter name;
 *  - every postMessage names its target origin explicitly, never "*";
 *  - this app never holds a Supabase token: ido-core writes with the founder's own session.
 * Without being embedded (or with an untrusted origin) the bridge does nothing at all.
 */

const SOURCE_SELF = "startup-voice";
const SOURCE_PARENT = "ido-core";
const VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param {object} deps
 * @param {(path: string, opts?: object) => Promise<any>} deps.api
 * @param {() => string|null} deps.getSessionId  active voice session
 * @param {(text: string) => void} [deps.onNotice]
 * @param {Window} [deps.win]       the iframe's own window
 * @param {number} [deps.debounceMs]
 */
export function createIdoBridge({ api, getSessionId, onNotice = () => {}, win = window, debounceMs = 800 }) {
  let origin = null;       // the one trusted ido-core origin, once verified
  let parent = null;
  let ideaId = null;
  let seq = 0;
  let timer = null;
  let flushing = false;
  let again = false;
  /** venture_key -> value we already handed over (applied, unchanged, or deliberately skipped) */
  let lastSent = new Map();
  /** note key -> body we already handed over */
  let lastNotes = new Map();
  const inFlight = new Map(); // seq -> {fields: [{venture_key, value}], notes: [{key, body}]}

  const post = (msg) => parent.postMessage({ source: SOURCE_SELF, v: VERSION, ...msg }, origin);

  function onMessage(ev) {
    if (ev.source !== parent || ev.origin !== origin) return;
    const d = ev.data;
    if (!d || d.source !== SOURCE_PARENT || d.v !== VERSION) return;
    if (d.type === "init") {
      if (typeof d.idea_id !== "string" || !UUID.test(d.idea_id)) return;
      ideaId = d.idea_id;
      lastSent = new Map(); // a new idea page: everything is news again
      lastNotes = new Map();
      void flush();
    } else if (d.type === "delta_result") {
      settle(d);
    }
  }

  function settle(d) {
    const sent = inFlight.get(d.seq);
    if (!sent) return;
    inFlight.delete(d.seq);
    const applied = new Set(Array.isArray(d.applied) ? d.applied : []);
    const skipped = Array.isArray(d.skipped) ? d.skipped : [];
    const skippedByKey = new Map(skipped.map((s) => [s.venture_key, s.reason]));
    for (const f of sent.fields) {
      const reason = skippedByKey.get(f.venture_key);
      // "error" is the only outcome worth retrying; everything else is final for this value.
      if (applied.has(f.venture_key) || (reason && reason !== "error")) lastSent.set(f.venture_key, f.value);
    }
    const notesApplied = new Set(Array.isArray(d.notes_applied) ? d.notes_applied : []);
    const notesSkipped = Array.isArray(d.notes_skipped) ? d.notes_skipped : [];
    const notesReason = new Map(notesSkipped.map((s) => [s.key, s.reason]));
    for (const n of sent.notes) {
      const reason = notesReason.get(n.key);
      if (notesApplied.has(n.key) || (reason && reason !== "error")) lastNotes.set(n.key, n.body);
    }

    const keptFields = skipped.filter((s) => s.reason === "founder_value").length;
    const keptCards = notesSkipped.filter((s) => s.reason === "founder_value").length;
    const parts = [];
    if (notesApplied.size) parts.push(notesApplied.size === 1 ? "1 Karte auf dem Board" : `${notesApplied.size} Karten auf dem Board`);
    if (applied.size) parts.push(applied.size === 1 ? "1 Feld" : `${applied.size} Felder`);
    let text = parts.length ? `${parts.join(" und ")} gespeichert.` : "";
    const kept = keptFields + keptCards;
    if (kept) {
      const what = kept === 1 ? "1 Eintrag" : `${kept} Einträge`;
      text += `${text ? " " : ""}${what} nicht überschrieben – du hast ${kept === 1 ? "ihn" : "sie"} in ido selbst geändert.`;
    }
    if (text) onNotice(text);
  }

  async function flush() {
    if (!origin || !ideaId) return;
    const sessionId = getSessionId();
    if (!sessionId) return;
    if (flushing) { again = true; return; }
    flushing = true;
    try {
      const delta = await api(`/api/sessions/${sessionId}/ido-delta`);
      const changed = (delta?.fields || [])
        .filter((f) => lastSent.get(f.venture_key) !== f.value)
        .map((f) => ({ venture_key: f.venture_key, value: f.value }));
      const changedNotes = (delta?.notes || [])
        .filter((n) => lastNotes.get(n.key) !== n.body)
        .map((n) => ({ key: n.key, body: n.body }));
      if (!changed.length && !changedNotes.length) return;
      seq += 1;
      inFlight.set(seq, { fields: changed, notes: changedNotes });
      post({
        type: "dossier_delta", seq, idea_id: ideaId, session_id: sessionId,
        fields: changed, notes: changedNotes,
      });
    } catch {
      /* offline / session gone: the next change tries again */
    } finally {
      flushing = false;
      if (again) { again = false; void flush(); }
    }
  }

  return {
    /** Verify the embedding, then announce ourselves. Resolves true when the bridge is live. */
    async start() {
      if (win.parent === win) return false; // opened on its own
      const wanted = new URLSearchParams(win.location.search).get("ido_origin");
      if (!wanted) return false;
      let allowed = [];
      try { allowed = (await api("/api/ido/config"))?.origins || []; } catch { return false; }
      if (!allowed.includes(wanted)) return false;
      origin = wanted;
      parent = win.parent;
      win.addEventListener("message", onMessage);
      post({ type: "ready" });
      return true;
    },
    /** Call whenever the app state changed (a turn finished, a proposal was resolved…). */
    onStateChange() {
      if (!origin || !ideaId) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void flush(); }, debounceMs);
    },
    flush,
    isActive: () => Boolean(origin),
    /** Test hook. */
    _state: () => ({ origin, ideaId, seq, lastSent: Object.fromEntries(lastSent), lastNotes: Object.fromEntries(lastNotes) }),
  };
}
