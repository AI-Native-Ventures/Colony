import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CROCKFORD_ALPHABET,
  deriveAuthKey,
  generateRecoveryCode,
  hashRecoveryCode,
  normaliseEmail,
} from "./authCrypto.ts";

test("normalises case and surrounding whitespace", () => {
  assert.equal(normaliseEmail("  Founder@Example.COM "), "founder@example.com");
});

test("derives a stable 64 character key for the same inputs", async () => {
  const first = await deriveAuthKey(
    "founder@example.com",
    "correct horse battery",
  );
  const second = await deriveAuthKey(
    "founder@example.com",
    "correct horse battery",
  );
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("the same password on a different address derives a different key", async () => {
  const first = await deriveAuthKey("a@x.com", "correct horse battery");
  const second = await deriveAuthKey("b@x.com", "correct horse battery");
  assert.notEqual(first, second);
});

test("email case does not change the derived key", async () => {
  const lower = await deriveAuthKey(
    "founder@example.com",
    "correct horse battery",
  );
  const upper = await deriveAuthKey(
    "FOUNDER@EXAMPLE.COM",
    "correct horse battery",
  );
  assert.equal(lower, upper);
});

test("a different password derives a different key", async () => {
  const first = await deriveAuthKey("a@x.com", "correct horse battery");
  const second = await deriveAuthKey("a@x.com", "correct horse batteries");
  assert.notEqual(first, second);
});

test("recovery codes are four groups of five Crockford characters", () => {
  const code = generateRecoveryCode();
  assert.equal(code.length, 23);
  const groups = code.split("-");
  assert.equal(groups.length, 4);
  for (const group of groups) {
    assert.equal(group.length, 5);
    for (const character of group) {
      assert.ok(
        CROCKFORD_ALPHABET.includes(character),
        `${character} is outside the alphabet`,
      );
    }
  }
});

test("recovery codes do not repeat", () => {
  assert.notEqual(generateRecoveryCode(), generateRecoveryCode());
});

test("recovery code hashing ignores case and spacing", async () => {
  const code = generateRecoveryCode();
  assert.equal(
    await hashRecoveryCode(code),
    await hashRecoveryCode(` ${code.toLowerCase()} `),
  );
});
