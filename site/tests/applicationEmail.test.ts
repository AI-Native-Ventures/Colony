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
  work: "A café's website? Prices #1: R200 & R300.\n写真 and 🐜 posts = yes!",
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
  assert.match(draft.body, /My business: I'm starting a business/);
  assert.match(draft.body, /What I'd like to do in Colony:/);
  assert.ok(draft.body.endsWith(application.work));
});

test("visitor text cannot change the recipient or add email headers", () => {
  const attemptedHeader = "\r\nBcc: someone@example.net&cc=another@example.net";
  const maliciousApplication = {
    ...application,
    name: `Visitor${attemptedHeader}`,
    work: "&subject=Changed&body=Overwritten#hidden",
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
  assert.ok(link.searchParams.get("body")?.endsWith(maliciousApplication.work));
  assert.equal(link.hash, "");
});

test("the copy fallback includes the fixed destination and trims business details", () => {
  const draft = buildApplicationEmail({
    ...application,
    name: "  Ana  ",
    email: "  ana@example.com  ",
    stage: "existing",
    work: "  Help with my bakery's work.  ",
  });

  assert.ok(draft.clipboardText.startsWith("To: basheer@ainative.ventures\n"));
  assert.ok(draft.clipboardText.includes(`Subject: ${draft.subject}\n\n`));
  assert.ok(draft.clipboardText.endsWith(draft.body));
  assert.match(draft.body, /Name: Ana\r\n/);
  assert.match(draft.body, /Email: ana@example.com\r\n/);
  assert.match(draft.body, /My business: I already run a business/);
  assert.ok(draft.body.endsWith("Help with my bakery's work."));

  const exploringDraft = buildApplicationEmail({
    ...application,
    stage: "exploring",
  });
  assert.match(exploringDraft.body, /My business: I'm exploring an idea/);
});
