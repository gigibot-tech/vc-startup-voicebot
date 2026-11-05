/** Header badge, hero hint and dossier caption: "which conversation am I in?" (pure DOM text). */

import { fmtTs, langTag } from "../../shared/format.js";
import { activeSession } from "../../shared/state.js";
import { chromeLang, t } from "../prefs/chrome-i18n.js";
import { sessionClosureLabel } from "./session-list.js";

const setText = (id, text) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

/** Keep #langSel in sync with active session language, else prefs. */
function syncLangSelect(prefLanguage) {
  const sel = document.getElementById("langSel");
  if (!sel) return;
  const session = activeSession();
  const code = session?.language || prefLanguage();
  const tag = langTag(code);
  if (sel.value !== tag) sel.value = tag;
}

/**
 * @param {{sttLabel: () => string, prefLanguage: () => string}} deps
 * Badge = STT (+ session id). Language lives in the header #langSel.
 */
export function renderMeta({ sttLabel, prefLanguage }) {
  const stt = sttLabel();
  const session = activeSession();
  syncLangSelect(prefLanguage);
  const lang = chromeLang(session?.language || prefLanguage());
  if (!session) {
    setText("modeBadge", stt);
    setText("sessionHint", t("sessionHintPick", lang));
    setText("dossierMeta", t("dossierMetaNone", lang));
    return;
  }
  const short = String(session.id).slice(0, 8);
  setText("modeBadge", `${stt} · ${short}`);
  const closure = sessionClosureLabel(session, { lang });
  const hint = lang === "en"
    ? `Session ${short}${closure ? ` · ${closure}` : ""} — pick on the left or “New chat”.`
    : `Gespräch ${short}${closure ? ` · ${closure}` : ""} — links wählen oder „Neues Gespräch“.`;
  setText("sessionHint", hint);
  const metaBit = sessionClosureLabel(session, { short: true, lang });
  setText(
    "dossierMeta",
    lang === "en"
      ? `Session ${session.id} · started ${fmtTs(session.created_at)} · Turn ${session.turn_index}${metaBit ? ` · ${metaBit}` : ""}`
      : `Gespräch ${session.id} · gestartet ${fmtTs(session.created_at)} · Turn ${session.turn_index}${metaBit ? ` · ${metaBit}` : ""}`,
  );
}
