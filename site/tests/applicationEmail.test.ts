import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_RECIPIENT,
  buildApplicationEmail,
  type EarlyAccessApplication,
} from "../src/sections/applicationEmail.ts";

const application: EarlyAccessApplication = {
  name: "Mpho & Ana + Partners",
  email: "mpho+colony@example.com",
  stage: "starting",
  service: "both",
  note: "A café's website? Prices #1: R200 & R300.\n写真 and 🐜 posts = yes!",
};

test("the email link preserves special characters and every application answer", () => {
  const draft = buildApplicationEmail(application);
  const link = new URL(draft.mailto);

  assert.equal(link.protocol, "mailto:");
  assert.equal(link.pathname, APPLICATION_RECIPIENT);
  assert.equal(link.searchParams.get("subject"), draft.subject);
  assert.equal(link.searchParams.get("body"), draft.body);
  assert.equal(link.hash, "");
  assert.match(draft.body, /Name: Mpho & Ana \+ Partners/);
  assert.match(draft.body, /Email: mpho\+colony@example.com/);
  assert.match(draft.body, /My agency: I'm starting an agency/);
  assert.match(draft.body, /I'm interested in: Websites and social media/);
  assert.ok(draft.body.endsWith(application.note));
});

test("visitor text cannot change the recipient or add email headers", () => {
  const attemptedHeader = "\r\nBcc: someone@example.net&cc=another@example.net";
  const maliciousApplication = {
    ...application,
    name: `Visitor${attemptedHeader}`,
    note: "&subject=Changed&body=Overwritten#hidden",
    recipient: "someone@example.net",
    subject: "Changed",
  };
  const draft = buildApplicationEmail(maliciousApplication);
  const link = new URL(draft.mailto);

  assert.equal(draft.recipient, "basheer@ainative.ventures");
  assert.equal(link.pathname, "basheer@ainative.ventures");
  assert.deepEqual([...link.searchParams.keys()], ["subject", "body"]);
  assert.equal(
    link.searchParams.get("subject"),
    "Colony early access application",
  );
  assert.ok(link.searchParams.get("body")?.includes(attemptedHeader));
  assert.ok(link.searchParams.get("body")?.endsWith(maliciousApplication.note));
  assert.equal(link.hash, "");
});

test("the copy fallback includes the fixed destination and optional notes can be empty", () => {
  const draft = buildApplicationEmail({
    ...application,
    name: "  Ana  ",
    stage: "existing",
    service: "websites",
    note: "  ",
  });

  assert.ok(draft.clipboardText.startsWith("To: basheer@ainative.ventures\n"));
  assert.ok(draft.clipboardText.includes(`Subject: ${draft.subject}\n\n`));
  assert.ok(draft.clipboardText.endsWith(draft.body));
  assert.match(draft.body, /Name: Ana\r\n/);
  assert.match(draft.body, /My agency: I already run an agency/);
  assert.match(draft.body, /I'm interested in: Websites$/);
  assert.doesNotMatch(draft.body, /What I'd like help with/);
});
