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

/** Badge: field-fill % ≠ quality status (status comes from deterministic eval, not LLM). */
export function slotBadgeLabel(st, fieldPct, specPct) {
  const pct = Math.round(fieldPct * 100);
  if (st === "solid") return `Belastbar · ${pct}% Felder`;
  if (st === "open") return `Offen · ${pct}%`;
  // partial: fields may be full while evidence is still vague (no numbers/concrete markers)
  if (pct >= 100) {
    const q = Number.isFinite(specPct) ? ` · Schärfe ${Math.round(specPct * 100)}%` : "";
    return `Felder voll · Aspekte unscharf${q}`;
  }
  return `Lückenhaft · ${pct}% Felder`;
}
