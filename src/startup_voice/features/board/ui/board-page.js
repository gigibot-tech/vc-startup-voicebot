// Public board: lists dossiers whose authors chose to be listed. User text is ONLY ever put into the
// page as plain text nodes (textContent), so nothing an author writes can run as code.
const grid = document.getElementById("grid");
const empty = document.getElementById("empty");
const LABELS = { product: "Product", traction: "Traction", market: "Market", financing: "Financing" };

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

try {
  const res = await fetch("/api/public/board");
  const data = await res.json();
  const cta = document.getElementById("cta");
  const base = String(data.cta_url || "").replace(/\/$/, "");
  if (base.startsWith("https://") || base.startsWith("http://")) cta.href = `${base}/signup`;
  else cta.hidden = true;

  if (!data.items.length) empty.hidden = false;
  for (const item of data.items) {
    const card = el("a", "card");
    card.href = `/d/${encodeURIComponent(item.slug)}`;
    card.append(el("h2", "", item.title));
    if (item.excerpt) card.append(el("p", "", item.excerpt));
    const chips = el("div", "chips");
    for (const k of item.sections) chips.append(el("span", `chip ${k}`, LABELS[k] || k));
    card.append(chips, el("span", "date", new Date(item.published_at).toLocaleDateString()));
    grid.append(card);
  }
} catch {
  empty.textContent = "The board could not be loaded.";
  empty.hidden = false;
}
