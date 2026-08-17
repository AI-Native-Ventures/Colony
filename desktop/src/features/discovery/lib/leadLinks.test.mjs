import assert from "node:assert/strict";
import { test } from "node:test";

import { leadMailtoUrl, leadTelUrl, leadWebUrl } from "./leadLinks.ts";

test("a bare host is promoted to https rather than resolved against the app", () => {
  assert.equal(leadWebUrl("acme.example"), "https://acme.example/");
  assert.equal(
    leadWebUrl("  acme.example/pricing  "),
    "https://acme.example/pricing",
  );
});

test("an absolute web address is preserved", () => {
  assert.equal(leadWebUrl("https://acme.example/x"), "https://acme.example/x");
  assert.equal(leadWebUrl("http://acme.example/"), "http://acme.example/");
});

test("a non-web scheme is refused rather than handed to the OS opener", () => {
  // These reach the native opener if they are trusted, so each one is a way
  // out of the webview and none of them is a web page.
  assert.equal(leadWebUrl("javascript:alert(1)"), null);
  assert.equal(leadWebUrl("file:///etc/passwd"), null);
  assert.equal(leadWebUrl("data:text/html,<script>alert(1)</script>"), null);
});

test("an empty or missing website yields no link", () => {
  assert.equal(leadWebUrl(null), null);
  assert.equal(leadWebUrl(undefined), null);
  assert.equal(leadWebUrl("   "), null);
});

test("an email becomes a mailto only when it looks like an address", () => {
  assert.equal(
    leadMailtoUrl("hello@acme.example"),
    "mailto:hello@acme.example",
  );
  assert.equal(leadMailtoUrl("not-an-address"), null);
  assert.equal(leadMailtoUrl("two addresses@a.example"), null);
  assert.equal(leadMailtoUrl(null), null);
});

test("a phone number keeps its dialable characters only", () => {
  assert.equal(leadTelUrl("+27 11 555 0100"), "tel:+27115550100");
  assert.equal(leadTelUrl("(011) 555-0100"), "tel:0115550100");
  assert.equal(leadTelUrl("not a phone"), null);
  assert.equal(leadTelUrl(null), null);
});
