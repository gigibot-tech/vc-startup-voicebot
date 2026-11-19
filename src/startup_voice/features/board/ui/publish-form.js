/**
 * Pure helpers for the publish dialog (no DOM): what is sent, and what is still missing.
 * The server checks everything again (features/board/store.py); this is for fast, friendly feedback.
 */

export const SECTIONS = ["product", "traction", "market", "financing"];
export const MAX_TITLE = 80;
export const MAX_SECTION = 3000;
export const MAX_TOTAL = 10000;

/** @param {{title:string, sections:Record<string,{on:boolean,text:string}>, listed:boolean, consent:boolean, listingConsent:boolean, email:string, emailConsent:boolean, ownerKey?:string, consentVersion:string}} f */
export function buildPayload(f) {
  const sections = {};
  for (const k of SECTIONS) {
    const s = f.sections?.[k];
    const text = String(s?.text ?? "").trim();
    if (s?.on && text) sections[k] = text;
  }
  const email = String(f.email ?? "").trim();
  return {
    title: String(f.title ?? "").trim(),
    sections,
    listed: Boolean(f.listed),
    consent: Boolean(f.consent),
    listing_consent: Boolean(f.listed && f.listingConsent),
    consent_version: f.consentVersion,
    email: email || null,
    email_consent: Boolean(email && f.emailConsent),
    owner_key: f.ownerKey ? String(f.ownerKey).trim() : null,
  };
}

/** Returns problem codes; an empty list means the form can be sent. */
export function problems(payload, { updating = false } = {}) {
  const out = [];
  if (!payload.title) out.push("title");
  if (payload.title.length > MAX_TITLE) out.push("title_long");
  const texts = Object.values(payload.sections);
  if (!texts.length) out.push("sections");
  if (texts.some((t) => t.length > MAX_SECTION)) out.push("section_long");
  if (texts.reduce((n, t) => n + t.length, 0) > MAX_TOTAL) out.push("total_long");
  if (!payload.consent) out.push("consent");
  if (payload.listed && !payload.listing_consent) out.push("listing_consent");
  if (payload.email && !payload.email_consent) out.push("email_consent");
  if (updating && !payload.owner_key) out.push("owner_key");
  return out;
}

export const absoluteUrl = (origin, path) => `${String(origin).replace(/\/$/, "")}${path}`;
