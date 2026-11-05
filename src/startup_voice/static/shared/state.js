/**
 * Shared UI state (single source of truth) + the stale-response guard.
 *
 * Every feature slice reads/writes `appState` and calls `notify()`; app.js subscribes once and
 * repaints. Nothing here knows about the DOM or the network.
 *
 * STALE-RESPONSE GUARD (`nav`)
 * ----------------------------
 * Any request that can outlive a conversation switch (open, turn, finalize, clear) does:
 *
 *     const seq = nav.seq;                  // remember "which navigation am I part of"
 *     const data = await api(...);
 *     if (nav.isStale(seq, id)) return;     // user moved on: drop the late answer
 *
 * `nav.bump()` is called on every switch (open / picker / new session), which invalidates
 * everything in flight.
 */

import { fmtTs } from "./format.js";

export const appState = {
  view: "picker", // picker | session
  sessionId: null,
  session: null,
  list: [],
  loading: false, // session open / finalize / turn in flight
  loadingKind: null, // 'open' | 'finalize' | 'turn' | null
  /**
   * In-flight work shown in the topbar (survives reply unlock while extract runs).
   * { kind: 'turn'|'extract'|'open'|'finalize', sessionId, message?, label? } | null
   */
  processBusy: null,
  /** Failed/interrupted turn still visible in chat: { sessionId, text, message } | null */
  turnError: null,
  /** Live label for the thinking bubble while loadingKind === "turn" */
  turnHint: null,
};

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const notify = () => { listeners.forEach((fn) => fn(appState)); };

export function setLoading(on, kind = null) {
  appState.loading = Boolean(on);
  appState.loadingKind = on ? kind : null;
  notify();
}

export function setTurnError(err) {
  appState.turnError = err;
  notify();
}

export function clearTurnError() {
  if (!appState.turnError) return;
  appState.turnError = null;
  notify();
}

/** Human label for a session id (list preview or short id) — used in the header process banner. */
export function sessionProcessLabel(sessionId) {
  if (!sessionId) return "";
  const item = (appState.list || []).find((x) => x.id === sessionId);
  if (item) {
    const preview = (item.preview && item.preview !== "—")
      ? item.preview.slice(0, 36)
      : sessionId.slice(0, 8);
    const when = item.created_at ? fmtTs(item.created_at) : "";
    return when ? `${when} · ${preview}` : preview;
  }
  const s = appState.session?.id === sessionId ? appState.session : null;
  if (s) {
    const user = [...(s.messages || [])].reverse().find((m) => m.role === "user");
    const preview = (user?.content || "").slice(0, 36) || sessionId.slice(0, 8);
    const when = s.created_at ? fmtTs(s.created_at) : "";
    return when ? `${when} · ${preview}` : preview;
  }
  return sessionId.slice(0, 8);
}

/**
 * @param {{ kind: string, sessionId: string, message?: string } | null} spec
 */
export function setProcessBusy(spec) {
  if (!spec || !spec.sessionId) {
    if (!appState.processBusy) return;
    appState.processBusy = null;
    notify();
    return;
  }
  const label = sessionProcessLabel(spec.sessionId);
  appState.processBusy = {
    kind: spec.kind || "turn",
    sessionId: spec.sessionId,
    message: spec.message || "",
    label,
  };
  notify();
}

export function clearProcessBusy() {
  if (!appState.processBusy) return;
  appState.processBusy = null;
  notify();
}

export function isProcessRunning() {
  return Boolean(
    appState.processBusy
    || nav.turnBusy
    || (appState.loading && (appState.loadingKind === "turn"
      || appState.loadingKind === "open"
      || appState.loadingKind === "finalize")),
  );
}

/**
 * Warn before killing in-flight turn / extract / open / finalize.
 * @param {string} [lang] "de" | "en" | BCP-47
 * @returns {boolean} true = ok to proceed (and caller should abort)
 */
export function confirmInterruptProcess(lang = "de") {
  if (!isProcessRunning()) return true;
  const de = String(lang || "de").toLowerCase().startsWith("de");
  const p = appState.processBusy;
  const kind = p?.kind || appState.loadingKind || "turn";
  const kindLabel = {
    turn: de ? "Antwort" : "Reply",
    extract: de ? "Dossier-Update" : "Dossier update",
    open: de ? "Laden" : "Loading",
    finalize: de ? "Abschluss" : "Finalize",
  }[kind] || kind;
  const msg = p?.message || kindLabel;
  const sessionBit = p?.label || sessionProcessLabel(p?.sessionId || appState.sessionId) || "—";
  return confirm(de
    ? `Prozess läuft noch (${msg})\nGespräch: ${sessionBit}\n\nWirklich unterbrechen?`
    : `A process is still running (${msg})\nSession: ${sessionBit}\n\nInterrupt anyway?`);
}

export const activeId = () => appState.sessionId;
export const isPicker = () => appState.view === "picker";
/** The loaded session, or null while picking / loading. */
export const activeSession = () => (
  appState.view === "session" && appState.session && appState.session.id === appState.sessionId
    ? appState.session
    : null
);

export const nav = {
  seq: 0,
  /** True while a turn (user message -> reply) is in flight; blocks double sends. */
  turnBusy: false,
  bump() { this.seq += 1; return this.seq; },
  isStale(seq, id) { return seq !== this.seq || appState.sessionId !== id; },
};
