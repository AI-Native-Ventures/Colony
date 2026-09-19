import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CROCKFORD_ALPHABET,
  deriveAuthKey,
  deriveLegacyAuthKey,
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

test("normalises the password, so the keyboard cannot change the key", async () => {
  // Which spelling a keyboard emits is not something a user chooses, and
  // NIP-49 already normalises before its scrypt, so an unnormalised auth key
  // meant the backup opened while the relay refused the same password.
  const composed = "caf\u00e9 battery staple";
  const decomposed = "cafe\u0301 battery staple";
  assert.notEqual(composed, decomposed);
  assert.equal(
    await deriveAuthKey("founder@example.com", composed),
    await deriveAuthKey("founder@example.com", decomposed),
  );
});

test("the legacy derivation still reaches pre-normalisation accounts", async () => {
  // An account created from a decomposed password has its auth_hash over
  // those exact bytes. Normalising everywhere would lock its owner out of an
  // account that works today, so sign-in falls back to this derivation.
  const composed = "caf\u00e9 battery staple";
  const decomposed = "cafe\u0301 battery staple";
  assert.notEqual(
    await deriveLegacyAuthKey("founder@example.com", composed),
    await deriveLegacyAuthKey("founder@example.com", decomposed),
  );
  // ASCII passwords are unaffected by either, which is why the fallback is
  // guarded on the password actually changing under NFKC.
  assert.equal(
    await deriveLegacyAuthKey("founder@example.com", "correct horse battery"),
    await deriveAuthKey("founder@example.com", "correct horse battery"),
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
