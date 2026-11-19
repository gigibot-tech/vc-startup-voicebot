/**
 * The Idea Board on the home screen, next to "Gespräch wählen": a short list of dossiers whose
 * authors chose to be listed (server: features/board/routes.py -> GET /api/public/board).
 * Author text is only ever shown as plain text nodes (textContent), never as HTML.
 */
const LABELS = {
  de: { product: "Produkt", traction: "Traktion", market: "Markt", financing: "Finanzierung" },
  en: { product: "Product", traction: "Traction", market: "Market", financing: "Financing" },
};
const MAX_SHOWN = 6;
const STALE_MS = 30000;

export function createHomeBoard({ api, getLanguage }) {
  const $ = (id) => document.getElementById(id);
  let loadedAt = 0;
  const lang = () => (String(getLanguage?.() || "de").toLowerCase().startsWith("en") ? "en" : "de");

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const emptyCopy = () => (lang() === "en"
    ? "Nothing published yet. You can publish your dossier later with “Share publicly…”."
    : "Noch nichts veröffentlicht. Du kannst dein Dossier später unter „Öffentlich teilen…“ veröffentlichen.");

  function paint(items, { error = false } = {}) {
    const list = $("homeBoardList");
    if (!list) return;
    list.replaceChildren();
    const empty = $("homeBoardEmpty");
    if (empty) {
      empty.hidden = !error && items.length > 0;
      empty.textContent = error
        ? (lang() === "en" ? "Idea Board unavailable right now." : "Idea Board gerade nicht erreichbar.")
        : emptyCopy();
    }
    for (const item of items.slice(0, MAX_SHOWN)) {
      const a = el("a", "hb-card");
      a.href = `/d/${encodeURIComponent(item.slug)}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.append(el("strong", "hb-title", item.title));
      if (item.excerpt) a.append(el("span", "hb-excerpt", item.excerpt));
      const chips = el("span", "hb-chips");
      for (const k of item.sections) chips.append(el("span", `hb-chip ${k}`, LABELS[lang()][k] || k));
      a.append(chips);
      list.append(a);
    }
    $("homeBoardMore").hidden = items.length <= MAX_SHOWN;
  }

  return {
    /** Load (at most every 30 s) and show the board. Safe to call on every repaint. */
    async refresh({ force = false } = {}) {
      if (!$("homeBoard") || $("homeBoard").hidden) return;
      if (!force && Date.now() - loadedAt < STALE_MS) return;
      loadedAt = Date.now();
      try {
        paint((await api("/api/public/board"))?.items || []);
      } catch (err) {
        loadedAt = 0; // try again next time
        paint([], { error: true });
        console.warn("home board refresh failed", err);
      }
    },
  };
}
