/** Dossier labels: loaded from GET /api/dossier-schema (SSOT); snake_case keys never shown as UI text. */

export const schema = {
  slotLabels: {
    team: "Team", product: "Produkt", traction: "Traktion",
    market: "Markt", financing: "Finanzierung",
  },
  fieldLabels: {},
  statusLabels: { open: "Offen", partial: "In Arbeit", solid: "Belastbar" },
};

export function fieldDisplayLabel(slot, key) {
  return (schema.fieldLabels[slot] && schema.fieldLabels[slot][key])
    || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function loadDossierSchema() {
  try {
    const data = await fetch("/api/dossier-schema").then((r) => r.json());
    const labels = {};
    const fields = {};
    (data.slots || []).forEach((s) => {
      labels[s.id] = s.label;
      fields[s.id] = {};
      (s.fields || []).forEach((f) => { fields[s.id][f.id] = f.label; });
    });
    schema.slotLabels = labels;
    schema.fieldLabels = fields;
    if (data.status_labels) schema.statusLabels = data.status_labels;
  } catch (_) { /* keep defaults */ }
}

/**
 * Badge text. "Belege %" = LLM evidence quality (DimensionState.belege via scoring.py):
 * how concrete / analyst-readable the slot text is — not keyword hits.
 * 0% = filled but vague; high = names, Zahlen, klare Verneinungen.
 */
export function slotBadgeLabel(st, fieldPct, specPct) {
  const pct = Math.round(fieldPct * 100);
  if (st === "solid") return `Solid · ${pct}%`;
  if (st === "open") return `Open · ${pct}%`;
  // partial: fields may be full while evidence is still vague
  if (pct >= 100) {
    return Number.isFinite(specPct)
      ? `Full · evidence ${Math.round(specPct * 100)}%`
      : "Full · still vague";
  }
  return `Incomplete · ${pct}%`;
}

/** Tooltip for the badge — explains Belege / status. */
export function slotBadgeTitle(st, fieldPct, specPct) {
  const pct = Math.round(fieldPct * 100);
  if (st === "solid") return "Solid: fields filled and evidence rated concrete/readable";
  if (st === "open") return "No usable answers in this slot yet";
  if (pct >= 100) {
    const s = Number.isFinite(specPct) ? Math.round(specPct * 100) : 0;
    return `All fields set, but evidence only ${s}% (LLM) — too vague for “Solid”.`;
  }
  return `Status ${schema.statusLabels[st] || st}`;
}
