/** Header badge, hero hint and dossier caption: "which conversation am I in?" (pure DOM text). */

import { fmtTs, langTag } from "../../shared/format.js";
import { activeSession } from "../../shared/state.js";
import { sessionClosureLabel } from "./session-list.js";

const setText = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

/** @param {{sttLabel: () => string, prefLanguage: () => string}} deps */
export function renderMeta({ sttLabel, prefLanguage }) {
  const stt = sttLabel();
  const session = activeSession();
  if (!session) {
    setText("modeBadge", `${stt} · ${langTag(prefLanguage())}`);
    setText("sessionHint", "Gespräch wählen oder neu starten.");
    setText("sessionHintCompact", "Gespräch wählen oder neu starten.");
    setText("dossierMeta", "Kein Gespräch geladen");
    return;
  }
  const short = String(session.id).slice(0, 8);
  setText("modeBadge", `${stt} · ${langTag(session.language)} · ${short}`);
  const closure = sessionClosureLabel(session);
  const hint = `Gespräch ${short}${closure ? ` · ${closure}` : ""} — links wählen oder „Neues Gespräch“.`;
  setText("sessionHint", hint);
  setText("sessionHintCompact", hint);
  const metaBit = sessionClosureLabel(session, { short: true });
  setText(
    "dossierMeta",
    `Session ${session.id} · gestartet ${fmtTs(session.created_at)} · Turn ${session.turn_index}${metaBit ? ` · ${metaBit}` : ""}`,
  );
}
