/**
 * "Öffentlich teilen…" — publish parts of the dossier on the public Idea Board.
 *
 * BUTTON -> HANDLER -> BACKEND  (server: features/board/routes.py)
 *   [Öffentlich teilen…] #publishBtn -> open() -> GET  /api/sessions/{id}/publish-preview
 *   [Veröffentlichen]                -> submit() -> POST /api/sessions/{id}/publish
 *   [Zurückziehen]                   -> withdraw() -> POST /api/public/{slug}/withdraw
 *
 * Private by default. The owner key comes back ONCE and is only ever held in memory here.
 */
import { SECTIONS, absoluteUrl, buildPayload, problems } from "./publish-form.js";

const T = {
  de: {
    title: "Öffentlich teilen", lead: "Nichts ist öffentlich, bis du hier veröffentlichst. Das Team wird nie veröffentlicht.",
    product: "Produkt", traction: "Traktion", market: "Markt", financing: "Finanzierung",
    pageTitle: "Titel der Seite", titleHint: "Kein Firmen- oder Personenname nötig.",
    consent: "Ich habe die Hinweise gelesen und stimme zu, die gewählten Abschnitte zu veröffentlichen.",
    listed: "Zusätzlich auf dem öffentlichen Idea Board anzeigen (sonst nur per Link erreichbar).",
    listingConsent: "Ich willige ein, dass Titel und Auszug auf der öffentlichen Liste erscheinen.",
    email: "E-Mail (optional, wird nie veröffentlicht)", emailConsent: "Ich willige ein, dass die E-Mail-Adresse gespeichert wird, damit man mich als Autor erreichen kann.",
    points: [
      "Jeder mit dem Link kann die gewählten Abschnitte ohne Anmeldung lesen.",
      "Veröffentlicht wird eine Kopie des Textes von jetzt. Spätere Änderungen bleiben privat, bis du erneut veröffentlichst.",
      "Schreibe keine Namen oder persönlichen Daten anderer Personen in die Abschnitte.",
      "Du kannst jederzeit zurückziehen: Der Text wird gelöscht, der Link funktioniert nicht mehr. Dafür brauchst du den Besitzer-Schlüssel.",
      "Gespeichert werden Text, Titel, Link, Datum, die Version dieser Einwilligung und (nur falls angegeben) deine E-Mail. Keine IP-Adressen.",
    ],
    draft: "Entwurf der Einwilligungstexte – vor dem Livegang rechtlich prüfen lassen.",
    publish: "Veröffentlichen", update: "Aktualisieren", cancel: "Schließen",
    already: "Bereits veröffentlicht", keyForUpdate: "Besitzer-Schlüssel (zum Aktualisieren oder Zurückziehen)",
    withdraw: "Zurückziehen und Text löschen", done: "Veröffentlicht.", link: "Link",
    keyTitle: "Dein Besitzer-Schlüssel", keyWarn: "Speichere ihn jetzt. Er wird nur einmal angezeigt und ist die einzige Möglichkeit, die Seite zu ändern oder zurückzuziehen.",
    copy: "Kopieren", copied: "Kopiert", withdrawn: "Zurückgezogen. Der Text wurde gelöscht.", loading: "Lade…",
    err: { title: "Bitte einen Titel eingeben.", title_long: "Der Titel ist zu lang.", sections: "Wähle mindestens einen Abschnitt mit Text.", section_long: "Ein Abschnitt ist zu lang (max. 3000 Zeichen).", total_long: "Zu viel Text insgesamt.", consent: "Die Einwilligung zum Veröffentlichen fehlt.", listing_consent: "Die Einwilligung zur Auflistung fehlt.", email_consent: "Die Einwilligung zur E-Mail-Speicherung fehlt.", owner_key: "Der Besitzer-Schlüssel fehlt." },
    nothing: "Noch kein Inhalt im Dossier. Beantworte erst ein paar Fragen im Interview.",
  },
  en: {
    title: "Share publicly", lead: "Nothing is public until you publish here. The team is never published.",
    product: "Product", traction: "Traction", market: "Market", financing: "Financing",
    pageTitle: "Page title", titleHint: "No company or personal name needed.",
    consent: "I have read the notes and agree to publish the selected sections.",
    listed: "Also show on the public Idea Board (otherwise reachable by link only).",
    listingConsent: "I agree that the title and an excerpt appear on the public list.",
    email: "E-mail (optional, never published)", emailConsent: "I agree that my e-mail address is stored so I can be reached as the author.",
    points: [
      "Anyone with the link can read the selected sections without logging in.",
      "A copy of the text as it is now is published. Later changes stay private until you publish again.",
      "Do not write names or personal data of other people into the sections.",
      "You can withdraw at any time: the text is deleted and the link stops working. You need the owner key for that.",
      "We store the text, title, link, date, the version of this consent and, only if given, your e-mail. No IP addresses.",
    ],
    draft: "Draft consent wording – have it legally reviewed before going live.",
    publish: "Publish", update: "Update", cancel: "Close",
    already: "Already published", keyForUpdate: "Owner key (to update or withdraw)",
    withdraw: "Withdraw and delete the text", done: "Published.", link: "Link",
    keyTitle: "Your owner key", keyWarn: "Save it now. It is shown only once and is the only way to change or withdraw the page.",
    copy: "Copy", copied: "Copied", withdrawn: "Withdrawn. The text was deleted.", loading: "Loading…",
    err: { title: "Please enter a title.", title_long: "The title is too long.", sections: "Select at least one section with text.", section_long: "A section is too long (max 3000 characters).", total_long: "Too much text overall.", consent: "Consent to publish is missing.", listing_consent: "Consent to being listed is missing.", email_consent: "Consent to store the e-mail is missing.", owner_key: "The owner key is missing." },
    nothing: "The dossier has no content yet. Answer a few questions in the interview first.",
  },
};

export function createPublishDialog({ api, getSessionId, getLanguage }) {
  const $ = (id) => document.getElementById(id);
  const lang = () => (String(getLanguage?.() || "de").toLowerCase().startsWith("en") ? "en" : "de");
  const tx = () => T[lang()];
  let preview = null;
  let ownerKey = ""; // in memory only, never stored

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function field(labelText, control) {
    const wrap = el("label", "pub-field");
    wrap.append(el("span", "pub-label", labelText), control);
    return wrap;
  }
  function check(id, labelText) {
    const wrap = el("label", "pub-check");
    const box = el("input");
    box.type = "checkbox";
    box.id = id;
    wrap.append(box, el("span", "", labelText));
    return wrap;
  }

  function render() {
    const t = tx();
    const body = $("publishBody");
    body.replaceChildren();
    body.append(el("p", "pub-lead", t.lead));
    const have = SECTIONS.filter((k) => preview.sections[k]);
    if (!have.length) { body.append(el("p", "pub-note", t.nothing)); return; }

    const ex = preview.existing;
    if (ex?.published) {
      const row = el("p", "pub-note", `${t.already}: `);
      const a = el("a", "", absoluteUrl(location.origin, `/d/${ex.slug}`));
      a.href = `/d/${ex.slug}`; a.target = "_blank"; a.rel = "noopener";
      row.append(a);
      body.append(row);
    }

    for (const k of have) {
      const box = el("div", "pub-section");
      const head = check(`pub-on-${k}`, t[k]);
      head.querySelector("input").checked = false;
      const ta = el("textarea");
      ta.id = `pub-text-${k}`; ta.rows = 4; ta.value = preview.sections[k]; ta.maxLength = 3000;
      box.append(head, ta);
      body.append(box);
    }
    const title = el("input"); title.type = "text"; title.id = "pub-title"; title.maxLength = 80;
    title.value = ex?.title || "";
    body.append(field(`${t.pageTitle} — ${t.titleHint}`, title));

    const notes = el("div", "pub-consent");
    const ul = el("ul");
    for (const p of t.points) ul.append(el("li", "", p));
    notes.append(ul, el("p", "pub-draft", t.draft));
    body.append(notes, check("pub-consent", t.consent), check("pub-listed", t.listed));
    const listingConsent = check("pub-listing-consent", t.listingConsent);
    listingConsent.hidden = true;
    body.append(listingConsent);
    $("pub-listed").addEventListener("change", () => {
      listingConsent.hidden = !$("pub-listed").checked;
      if (listingConsent.hidden) $("pub-listing-consent").checked = false;
    });

    const email = el("input"); email.type = "text"; email.id = "pub-email"; email.autocomplete = "email"; email.maxLength = 254;
    body.append(field(t.email, email), check("pub-email-consent", t.emailConsent));

    if (ex) {
      const key = el("input"); key.type = "password"; key.id = "pub-owner-key"; key.autocomplete = "off"; key.placeholder = "ik_…";
      body.append(field(t.keyForUpdate, key));
    }
    body.append(el("p", "pub-status", ""));
    $("publishStatusSlot")?.remove();
    $("publishSubmit").textContent = ex ? t.update : t.publish;
    $("publishSubmit").hidden = false;
    $("publishWithdraw").hidden = !ex?.published;
    $("publishWithdraw").textContent = t.withdraw;
  }

  const status = (text, ok) => {
    const s = document.querySelector("#publishBody .pub-status") || $("publishStatus");
    if (!s) return;
    s.textContent = text;
    s.className = `pub-status ${ok ? "ok" : "err"}`;
  };

  function collect() {
    const sections = {};
    for (const k of SECTIONS) {
      const on = $(`pub-on-${k}`);
      sections[k] = { on: Boolean(on?.checked), text: $(`pub-text-${k}`)?.value ?? "" };
    }
    return {
      title: $("pub-title")?.value ?? "",
      sections,
      listed: Boolean($("pub-listed")?.checked),
      consent: Boolean($("pub-consent")?.checked),
      listingConsent: Boolean($("pub-listing-consent")?.checked),
      email: $("pub-email")?.value ?? "",
      emailConsent: Boolean($("pub-email-consent")?.checked),
      ownerKey: $("pub-owner-key")?.value ?? "",
      consentVersion: preview.consent_version,
    };
  }

  function showResult(res) {
    const t = tx();
    const body = $("publishBody");
    body.replaceChildren(el("p", "pub-lead", t.done));
    const url = absoluteUrl(location.origin, res.path);
    const a = el("a", "", url); a.href = res.path; a.target = "_blank"; a.rel = "noopener";
    body.append(el("p", "pub-note", `${t.link}: `));
    body.lastChild.append(a);
    if (res.owner_key) {
      ownerKey = res.owner_key;
      const box = el("div", "pub-key");
      box.append(el("strong", "", t.keyTitle), el("code", "", ownerKey), el("p", "pub-note", t.keyWarn));
      const copy = el("button", "pill-outline", t.copy); copy.type = "button";
      copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(ownerKey); copy.textContent = t.copied; } catch { /* clipboard blocked */ } });
      box.append(copy);
      body.append(box);
    }
    $("publishSubmit").hidden = true;
    $("publishWithdraw").hidden = true;
  }

  async function submit() {
    const t = tx();
    const form = collect();
    const payload = buildPayload(form);
    const bad = problems(payload, { updating: Boolean(preview.existing) });
    if (bad.length) { status(t.err[bad[0]], false); return; }
    $("publishSubmit").disabled = true;
    try {
      const res = await api(`/api/sessions/${getSessionId()}/publish`, { method: "POST", body: JSON.stringify(payload) });
      showResult(res);
    } catch (err) {
      let msg = String(err?.message || err);
      try { msg = JSON.parse(msg).detail || msg; } catch { /* plain text */ }
      status(msg, false);
    } finally {
      $("publishSubmit").disabled = false;
    }
  }

  async function withdraw() {
    const t = tx();
    const key = $("pub-owner-key")?.value?.trim();
    if (!key) { status(t.err.owner_key, false); return; }
    try {
      await api(`/api/public/${preview.existing.slug}/withdraw`, { method: "POST", body: JSON.stringify({ owner_key: key }) });
      $("publishBody").replaceChildren(el("p", "pub-lead", t.withdrawn));
      $("publishSubmit").hidden = true;
      $("publishWithdraw").hidden = true;
    } catch (err) {
      let msg = String(err?.message || err);
      try { msg = JSON.parse(msg).detail || msg; } catch { /* plain text */ }
      status(msg, false);
    }
  }

  async function open() {
    const id = getSessionId();
    if (!id) return;
    const t = tx();
    $("publishTitle").textContent = t.title;
    $("publishClose").textContent = t.cancel;
    $("publishBody").replaceChildren(el("p", "pub-note", t.loading));
    $("publishSubmit").hidden = true;
    $("publishWithdraw").hidden = true;
    $("publishDialog").showModal();
    try {
      preview = await api(`/api/sessions/${id}/publish-preview`);
      render();
    } catch {
      $("publishBody").replaceChildren(el("p", "pub-note", "Error"));
    }
  }

  return {
    bind() {
      $("publishBtn")?.addEventListener("click", () => void open());
      $("publishClose")?.addEventListener("click", () => $("publishDialog").close());
      $("publishSubmit")?.addEventListener("click", () => void submit());
      $("publishWithdraw")?.addEventListener("click", () => void withdraw());
    },
  };
}
