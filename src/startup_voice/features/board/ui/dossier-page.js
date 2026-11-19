// One published dossier. As on the board: author text goes in with textContent only.
const slug = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
const LABELS = { product: "Product", traction: "Traction", market: "Market", financing: "Financing" };
const $ = (id) => document.getElementById(id);
const say = (id, text, ok) => {
  const s = $(id);
  s.textContent = text;
  s.className = `status ${ok ? "ok" : "err"}`;
};

async function load() {
  const res = await fetch(`/api/public/${encodeURIComponent(slug)}`);
  if (!res.ok) { $("missing").hidden = false; return; }
  const d = await res.json();
  document.title = d.title;
  $("title").textContent = d.title;
  $("date").textContent = `Published ${new Date(d.published_at).toLocaleDateString()}`;
  for (const k of ["product", "traction", "market", "financing"]) {
    if (!d.sections[k]) continue;
    const card = document.createElement("section");
    card.className = "card";
    const h = document.createElement("h2");
    h.textContent = LABELS[k];
    const p = document.createElement("p");
    p.textContent = d.sections[k];
    card.append(h, p);
    $("sections").append(card);
  }
  const base = String(d.cta_url || "").replace(/\/$/, "");
  if (base.startsWith("https://") || base.startsWith("http://")) $("cta").href = `${base}/signup`;
  else $("cta").hidden = true;
  $("doc").hidden = false;
}

$("reportForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch(`/api/public/${encodeURIComponent(slug)}/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: $("reportReason").value }),
  });
  say("reportStatus", res.ok ? "Thank you. The report was recorded." : "Could not send the report.", res.ok);
});

$("withdrawForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const res = await fetch(`/api/public/${encodeURIComponent(slug)}/withdraw`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner_key: $("ownerKey").value.trim() }),
  });
  if (res.ok) {
    say("withdrawStatus", "Withdrawn. The text was deleted and this link no longer works.", true);
    setTimeout(() => location.reload(), 1500);
  } else {
    say("withdrawStatus", res.status === 403 ? "That owner key is not correct." : "Could not withdraw.", false);
  }
});

load().catch(() => { $("missing").hidden = false; });
