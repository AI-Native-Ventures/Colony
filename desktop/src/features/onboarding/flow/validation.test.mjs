// desktop/src/features/onboarding/flow/validation.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import {
  descriptionShortfall,
  isEmail,
  isWebsite,
  normaliseWebsite,
  passwordShortfall,
} from "./validation.ts";

test("email_rejects_a_string_with_no_domain", () => {
  assert.equal(isEmail("not-an-email"), false);
  assert.equal(isEmail("a@b"), false);
  assert.equal(isEmail("aisha@rosebankauto.co.za"), true);
});

test("password_shortfall_counts_down_to_zero", () => {
  assert.equal(passwordShortfall(""), 12);
  assert.equal(passwordShortfall("abcd"), 8);
  assert.equal(passwordShortfall("colonyprototype"), 0);
});

// The Rust backup command refuses anything shorter than 12 characters, and
// signup encrypts the identity before it posts, so a password this screen
// accepts but the command rejects fails with a network-shaped error and no
// request. Guard the boundary in both directions.
test("password_minimum_matches_the_identity_backup_floor", () => {
  assert.equal(passwordShortfall("elevenchars"), 1);
  assert.equal(passwordShortfall("twelvechars!"), 0);
});

test("website_rejects_a_bare_word_and_accepts_a_domain", () => {
  assert.equal(isWebsite("asdf"), false);
  assert.equal(isWebsite("rosebankautocare.co.za"), true);
  assert.equal(isWebsite("https://rosebankautocare.co.za/services"), true);
});

test("website_normalises_to_a_scheme_qualified_url", () => {
  assert.equal(
    normaliseWebsite("rosebankautocare.co.za"),
    "https://rosebankautocare.co.za",
  );
  assert.equal(normaliseWebsite("http://example.com/"), "http://example.com");
});

test("description_shortfall_counts_trimmed_characters", () => {
  assert.equal(descriptionShortfall("   "), 20);
  assert.equal(descriptionShortfall("We fix cars in Joburg."), 0);
});
