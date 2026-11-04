/** Session list: pure label/list helpers + the view that paints sidebar, home list and dropdown. */
import { esc, fmtTs } from "../../shared/format.js";

/** Closure label for an open session object. `short` is used in compact meta lines. */
export function sessionClosureLabel(s, { short } = {}) {
  if (!s) return "";
  const ready = Boolean(s.evaluation && s.evaluation.ready_for_closing);
  if (s.finalized && ready) return short ? "fertig" : "fertig (vollständig)";
  if (s.finalized) return short ? "geschlossen" : "geschlossen (noch Lücken)";
  if (ready) return short ? "bereit" : "bereit zum Abschluss";
  return "";
}

/** Closure label for a list entry (GET /api/sessions item). */
export function listClosureLabel(item) {
  if (item.complete) return "fertig";
  if (item.finalized) return "geschlossen";
  if (item.ready_for_closing) return "bereit";
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
 * @param {{ sessionList: HTMLElement, homeSessionList: HTMLElement }} els
 */
export function createSessionListView({ sessionList, homeSessionList }) {
  /**
   * @param {{ items: object[], currentId: string|null, loading: boolean, loadingKind: string|null }} state
   */
  function render({ items, currentId, loading, loadingKind }) {
    // Spinner only for session open / finalize — not while sending a turn.
    const busyKind = (loadingKind === "open" || loadingKind === "finalize") ? loadingKind : null;
    const loadingId = (loading && busyKind) ? currentId : null;

    const listHtml = items.length ? items.map((item) => {
      const preview = (item.preview && item.preview !== "—")
        ? item.preview.slice(0, 48)
        : item.id.slice(0, 8);
      const tag = listClosureLabel(item);
      const isBusy = item.id === loadingId;
      const busyLabel = busyKind === "finalize" ? "schließt ab…" : "lädt…";
      return `<button type="button" class="session-item${item.id === currentId ? " active" : ""}${isBusy ? " is-loading" : ""}" data-id="${esc(item.id)}" ${isBusy ? "aria-busy=\"true\"" : ""}>
        <span class="t">${esc(fmtTs(item.created_at))}${tag ? ` · ${tag}` : ""}${isBusy ? ` · ${busyLabel}` : ""}</span>
        <span class="s">${esc(preview)}</span></button>`;
    }).join("") : `<div class="session-empty">Noch keine Gespräche</div>`;

    sessionList.innerHTML = listHtml;
    homeSessionList.innerHTML = listHtml;
  }
  return { render };
}
