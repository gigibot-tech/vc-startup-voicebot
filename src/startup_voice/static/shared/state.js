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

export const appState = {
  view: "picker", // picker | session
  sessionId: null,
  session: null,
  list: [],
  loading: false, // session open / finalize / turn in flight
  loadingKind: null, // 'open' | 'finalize' | 'turn' | null
};

const listeners = new Set();
export const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const notify = () => { listeners.forEach((fn) => fn(appState)); };

export function setLoading(on, kind = null) {
  appState.loading = Boolean(on);
  appState.loadingKind = on ? kind : null;
  notify();
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
