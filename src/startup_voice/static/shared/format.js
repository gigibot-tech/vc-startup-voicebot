/** Pure formatting / clamping helpers (no DOM, no state). */

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

export function fmtTs(iso) {
  try {
    return new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" });
  } catch { return iso || "—"; }
}

export const fmt01 = (n) => Number(n).toFixed(2).replace(".", ",");

export const clampSpeed = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.min(1.2, Math.max(0.75, n));
};

export const clamp01 = (v, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
};

/** Session language code ("de"/"en") -> BCP-47 tag for the browser Web Speech API. */
export const langTag = (code) => ({ de: "de-DE", en: "en-US" }[code] || "de-DE");
