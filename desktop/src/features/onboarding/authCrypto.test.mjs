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

test("agrees with the mobile client", async () => {
  // The cross-language invariant for sign-in, in the same spirit as
  // `agrees_with_the_typescript_client` in
  // `crates/buzz-auth/src/account_crypto.rs`. Mobile derives this value
  // independently, in Dart, in Swift (`CCKeyDerivationPBKDF`) and in Kotlin
  // (`javax.crypto.Mac`), and pins this exact hex in all three:
  //
  //   mobile/test/shared/auth/auth_crypto_test.dart
  //   mobile/ios/RunnerTests/RunnerTests.swift
  //   mobile/android/app/src/test/kotlin/.../PasswordKdfTest.kt
  //
  // Pinned rather than derived, so a change to any implementation fails here
  // instead of in production. If the four ever disagree the relay reports
  // `invalid_credentials` for a correct password, which is indistinguishable
  // from a typo and leaves nothing in any log to chase.
  assert.equal(
    await deriveAuthKey("founder@example.com", "correct horse battery"),
    "25e331a7de880c18d500eb562f99241e65a13f2ad5a0c664be0179d7cfc92082",
  );
});

test("does not normalise the password", async () => {
  // Deliberate, and the opposite of NIP-49, which NFKC-normalises before its
  // scrypt. Recorded here because it looks like an oversight: mobile must
  // match this rather than match NIP-49, or every user with an accented
  // password would be refused at sign-in while the backup still opened.
  const composed = "caf\u00e9 battery staple";
  const decomposed = "cafe\u0301 battery staple";
  assert.notEqual(composed, decomposed);
  assert.notEqual(
    await deriveAuthKey("founder@example.com", composed),
    await deriveAuthKey("founder@example.com", decomposed),
  );
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
