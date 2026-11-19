// Run: node --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { absoluteUrl, buildPayload, problems } from "../../src/startup_voice/features/board/ui/publish-form.js";

const form = (over = {}) => ({
  title: "  Meine Idee ", consentVersion: "v1", consent: true, listed: false, listingConsent: false,
  email: "", emailConsent: false,
  sections: { product: { on: true, text: " App " }, market: { on: false, text: "B2B" }, traction: { on: true, text: "   " } },
  ...over,
});

test("only ticked sections with text are sent, trimmed; team can never appear", () => {
  const p = buildPayload(form({ sections: { ...form().sections, team: { on: true, text: "Anna" } } }));
  assert.deepEqual(p.sections, { product: "App" });
  assert.equal(p.title, "Meine Idee");
  assert.ok(!("team" in p.sections));
});

test("listing consent only counts when listing is chosen; email consent only with an email", () => {
  const p = buildPayload(form({ listed: false, listingConsent: true, email: "", emailConsent: true }));
  assert.equal(p.listing_consent, false);
  assert.equal(p.email, null);
  assert.equal(p.email_consent, false);
  const q = buildPayload(form({ listed: true, listingConsent: true, email: "a@b.de", emailConsent: true }));
  assert.equal(q.listing_consent, true);
  assert.equal(q.email_consent, true);
});

test("a complete form has no problems", () => {
  assert.deepEqual(problems(buildPayload(form())), []);
});

test("every missing piece is named", () => {
  assert.deepEqual(problems(buildPayload(form({ title: " " }))), ["title"]);
  assert.deepEqual(problems(buildPayload(form({ consent: false }))), ["consent"]);
  assert.deepEqual(problems(buildPayload(form({ sections: {} }))), ["sections"]);
  assert.deepEqual(problems(buildPayload(form({ listed: true }))), ["listing_consent"]);
  assert.deepEqual(problems(buildPayload(form({ email: "a@b.de" }))), ["email_consent"]);
  assert.deepEqual(problems(buildPayload(form({ title: "x".repeat(81) }))), ["title_long"]);
  const long = { product: { on: true, text: "x".repeat(3001) } };
  assert.deepEqual(problems(buildPayload(form({ sections: long }))), ["section_long"]);
});

test("updating needs the owner key", () => {
  assert.deepEqual(problems(buildPayload(form()), { updating: true }), ["owner_key"]);
  assert.deepEqual(problems(buildPayload(form({ ownerKey: " ik_abc " })), { updating: true }), []);
  assert.equal(buildPayload(form({ ownerKey: " ik_abc " })).owner_key, "ik_abc");
});

test("absoluteUrl joins without double slashes", () => {
  assert.equal(absoluteUrl("https://x.org/", "/d/abc"), "https://x.org/d/abc");
});
