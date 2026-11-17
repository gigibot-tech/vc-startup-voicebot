/**
 * Keeps control tags out of the spoken text.
 *
 * The reply model ends its text with gates like `[[dossier:yes]]` / `[[intake:end]]`. They arrive
 * token by token, so a half-written `[[dossi` must be HELD BACK until we know whether it is a gate
 * (drop it) or ordinary text (let it through). Pure functions, no DOM: unit-tested with node.
 *
 * Used by voice-livekit.js. (voice.js, the classic driver, has its own sentence-based copy of
 * this logic; it is deliberately left untouched.)
 */

const GATE = /\[\[\s*(?:dossier\s*:\s*(?:yes|no)|intake\s*:\s*end)\s*\]\]/i;
/** A `[[` that has not closed yet and could still turn out to be a gate. */
const MAX_HELD = 40;

/** Remove every gate and tidy whitespace. */
export function stripGates(text) {
  return String(text || "")
    .replace(new RegExp(GATE.source, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createGateFilter() {
  let held = ""; // text not released yet (may start with a partial gate)
  let sent = ""; // everything released so far

  /** Feed one streamed chunk; returns the text that is safe to speak now ("" = keep waiting). */
  function push(chunk) {
    held += String(chunk || "");
    let out = "";
    for (;;) {
      const open = held.indexOf("[[");
      if (open < 0) {
        // A lone trailing "[" might be the first half of "[[": keep it back.
        const keep = held.endsWith("[") ? 1 : 0;
        out += held.slice(0, held.length - keep);
        held = held.slice(held.length - keep);
        break;
      }
      out += held.slice(0, open);
      const rest = held.slice(open);
      const m = rest.match(new RegExp(`^${GATE.source}`, "i"));
      if (m) {
        // Complete gate: drop it (and the space that preceded it).
        out = out.replace(/\s+$/, "");
        held = rest.slice(m[0].length);
        continue;
      }
      const closed = rest.indexOf("]]") >= 0;
      if (!closed && rest.length < MAX_HELD) {
        held = rest; // still might become a gate
        break;
      }
      // Closed but not a gate, or too long to be one: it is ordinary text.
      out += "[[";
      held = rest.slice(2);
    }
    sent += out;
    return out;
  }

  /**
   * Stream finished. `finalText` is the server's authoritative clean reply: returns whatever of it
   * was not released yet. Text already spoken is never re-spoken or taken back.
   */
  function finish(finalText) {
    const clean = stripGates(finalText);
    const spoken = stripGates(sent);
    held = "";
    if (!spoken) return clean;
    if (clean.length > spoken.length && clean.startsWith(spoken)) {
      const rest = clean.slice(spoken.length).trimStart();
      // Exactly one space between what was said and what follows, never two, never none.
      return rest && !/\s$/.test(sent) ? ` ${rest}` : rest;
    }
    return "";
  }

  return { push, finish, sent: () => sent };
}
