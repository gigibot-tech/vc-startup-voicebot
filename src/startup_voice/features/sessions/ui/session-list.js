/** Session list: pure label/list helpers + the view that paints sidebar, home list and top select. */
import { esc, fmtTs } from "../../shared/format.js";
import { chromeLang, t } from "../prefs/chrome-i18n.js";
import { prefs } from "../prefs/prefs.js";

/** Closure label for an open session object. `short` is used in compact meta lines. */
export function sessionClosureLabel(s, { short, lang } = {}) {
  if (!s) return "";
  const de = chromeLang(lang || prefs.lang) === "de";
  const ev = s.evaluation || {};
  const cov = Math.round(Number(ev.field_coverage || 0) * 100);
  const ready = Boolean(ev.ready_for_closing || cov >= 100);
  const vCount = Array.isArray(s.dossier_versions) ? s.dossier_versions.length : 0;
  if (s.finalized && ready) {
    const vBit = vCount ? ` v${vCount}` : "";
    return short
      ? (de ? `fertig${vBit}` : `complete${vBit}`)
      : (de ? `vollständig gespeichert${vBit}` : `complete & saved${vBit}`);
  }
  if (s.finalized) {
    return short ? (de ? "geschlossen" : "closed") : (de ? "geschlossen (noch Lücken)" : "closed (still gaps)");
  }
  if (ready) {
    return short ? (de ? "100% komplett" : "100% complete") : (de ? "100% vollständig — bereit zum Speichern" : "100% complete — ready to save");
  }
  if (cov >= 85) {
    return short ? (de ? `${cov}% fast fertig` : `${cov}% almost done`) : (de ? `${cov}% fast vollständig` : `${cov}% almost complete`);
  }
  return cov > 0 ? `${cov}%` : "";
}

/** Closure label for a list entry (GET /api/sessions item). */
export function listClosureLabel(item, lang) {
  const de = chromeLang(lang || prefs.lang) === "de";
  const cov = Math.round(Number(item.field_coverage || 0) * 100);
  if (item.complete) return de ? "komplett ✓" : "complete ✓";
  if (item.finalized) return de ? "geschlossen" : "closed";
  if (item.ready_for_closing || cov >= 100) return de ? "100% komplett" : "100% complete";
  if (cov >= 85) return de ? `${cov}% · fast fertig` : `${cov}% · almost done`;
  if (cov > 0) return `${cov}%`;
  return "";
}

export function previewFromSession(s) {
  const user = [...(s.messages || [])].reverse().find((m) => m.role === "user");
  return (user && user.content ? user.content.slice(0, 72) : "") || "—";
}

/** Returns a new list with `s` merged in (newest first). Keeps sidebar in sync with a slow list fetch. */
export function upsertSession(list, s) {
  if (!s || !s.id) return list;
  const ev = s.evaluation || {};
  const item = {
    id: s.id,
    created_at: s.created_at,
    turn_index: s.turn_index,
    finalized: Boolean(s.finalized),
    ready_for_closing: Boolean(ev.ready_for_closing),
    complete: Boolean(s.finalized && ev.ready_for_closing),
    field_coverage: Number(ev.field_coverage || 0),
    preview: previewFromSession(s),
  };
  const idx = list.findIndex((x) => x.id === s.id);
  const next = idx >= 0
    ? list.map((x, i) => (i === idx ? { ...x, ...item } : x))
    : [item, ...list];
  return next.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
}

/**
 * @param {{ sessionList: HTMLElement, homeSessionList: HTMLElement, sessionPick?: HTMLSelectElement|null }} els
 */
export function createSessionListView({ sessionList, homeSessionList, sessionPick }) {
  /**
   * @param {{ items: object[], currentId: string|null, loading: boolean, loadingKind: string|null, processBusy?: object|null }} state
   */
  function render({ items, currentId, loading, loadingKind, processBusy }) {
    // Spinner for open / finalize / turn / extract (header owns the copy; list shows a short tag).
    const processId = processBusy?.sessionId || null;
    const processKind = processBusy?.kind || null;
    const busyKind = processKind
      || ((loading && (loadingKind === "open" || loadingKind === "finalize")) ? loadingKind : null);
    const loadingId = processId || ((loading && busyKind) ? currentId : null);
    const lang = chromeLang(prefs.lang);
    const de = lang === "de";

    const listHtml = items.length ? items.map((item) => {
      const preview = (item.preview && item.preview !== "—")
        ? item.preview.slice(0, 48)
        : item.id.slice(0, 8);
      const tag = listClosureLabel(item, lang);
      const isBusy = item.id === loadingId;
      const busyLabel = busyKind === "finalize"
        ? (de ? "schließt ab…" : "finalizing…")
        : busyKind === "extract"
          ? (de ? "Dossier…" : "dossier…")
          : busyKind === "turn"
            ? (de ? "antwortet…" : "replying…")
            : (de ? "lädt…" : "loading…");
      const isComplete = Boolean(item.complete || item.ready_for_closing || Number(item.field_coverage || 0) >= 1);
      const isAlmost = !isComplete && Number(item.field_coverage || 0) >= 0.85;
      const stageCls = isComplete ? " is-complete" : (isAlmost ? " is-almost" : "");
      return `<button type="button" class="session-item${item.id === currentId ? " active" : ""}${stageCls}${isBusy ? " is-loading" : ""}" data-id="${esc(item.id)}" ${isBusy ? "aria-busy=\"true\"" : ""}>
        <span class="t">${esc(fmtTs(item.created_at))}${tag ? ` · <span class="session-item__tag">${esc(tag)}</span>` : ""}${isBusy ? ` · ${busyLabel}` : ""}</span>
        <span class="s">${esc(preview)}</span></button>`;
    }).join("") : `<div class="session-empty">${esc(t("noSessions", lang))}</div>`;

    sessionList.innerHTML = listHtml;
    homeSessionList.innerHTML = listHtml;

    // Topbar <select> is only used while the sidebar is collapsed (see settings.js).
    if (sessionPick) {
      const opts = items.length
        ? items.map((item) => {
          const label = `${fmtTs(item.created_at)} · ${(item.preview && item.preview !== "—") ? item.preview.slice(0, 28) : item.id.slice(0, 8)}`;
          return `<option value="${esc(item.id)}"${item.id === currentId ? " selected" : ""}>${esc(label)}</option>`;
        }).join("")
        : `<option value="">${esc(t("noSessions", lang))}</option>`;
      sessionPick.innerHTML = `<option value="">${esc(t("sessionPick", lang))}</option>${opts}`;
      if (currentId) sessionPick.value = currentId;
    }
  }
  return { render };
}
