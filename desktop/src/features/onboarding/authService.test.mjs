import assert from "node:assert/strict";
import { test } from "node:test";

import { createAuthService } from "./authService.ts";

function deps(overrides = {}) {
  return {
    post: async () => ({
      status: 201,
      body: { pubkey: "a".repeat(64), accountId: "id" },
    }),
    // A stand-in cipher: deterministic and distinct per input, but it must not
    // echo its input verbatim or the never-send-the-password assertion below
    // would fail even against a correct service.
    createBackup: async (secret) => `ncryptsec1${btoa(secret)}`,
    importIdentity: async () => {},
    getPubkey: async () => "b".repeat(64),
    generateCode: () => "ABCDE-FGHJK-MNPQR-STVWX",
    ...overrides,
  };
}

test("signUp returns the pubkey and the recovery code", async () => {
  let sent;
  const auth = createAuthService(
    deps({
      post: async (_path, body) => {
        sent = body;
        return {
          status: 201,
          body: { pubkey: "a".repeat(64), accountId: "id" },
        };
      },
    }),
  );
  const result = await auth.signUp(
    "founder@example.com",
    "correct horse battery",
  );
  assert.equal(result.recoveryCode, "ABCDE-FGHJK-MNPQR-STVWX");
  assert.equal(sent.pubkey, "b".repeat(64), "the local identity is escrowed");
  assert.equal(
    result.pubkey,
    "a".repeat(64),
    "the relay's answer is authoritative",
  );
});

test("signUp sends two different blobs and never sends the password", async () => {
  let sent;
  const auth = createAuthService(
    deps({
      post: async (_path, body) => {
        sent = body;
        return {
          status: 201,
          body: { pubkey: "a".repeat(64), accountId: "id" },
        };
      },
    }),
  );
  await auth.signUp("Founder@Example.COM", "correct horse battery");
  assert.notEqual(sent.passwordBlob, sent.recoveryBlob);
  const serialised = JSON.stringify(sent);
  assert.ok(
    !serialised.includes("correct horse battery"),
    "the password must never be sent",
  );
  assert.equal(sent.email, "founder@example.com");
  assert.match(sent.authKey, /^[0-9a-f]{64}$/);
  assert.match(sent.recoveryCodeHash, /^[0-9a-f]{64}$/);
  assert.equal(sent.kdfVersion, 1);
});

test("a taken address maps to email-taken", async () => {
  const auth = createAuthService(
    deps({
      post: async () => ({ status: 409, body: { error: "email_taken" } }),
    }),
  );
  await assert.rejects(
    () => auth.signUp("founder@example.com", "correct horse battery"),
    (error) => error.kind === "email-taken",
  );
});

test("a taken identity maps to identity-taken, not unreachable", async () => {
  // The relay answers 409 pubkey_taken when this computer's key already has an
  // account under another email. Nothing about the connection is wrong, and
  // retrying can never succeed, so this must not land on unreachable.
  const auth = createAuthService(
    deps({
      post: async () => ({ status: 409, body: { error: "pubkey_taken" } }),
    }),
  );
  await assert.rejects(
    () => auth.signUp("second@example.com", "correct horse battery"),
    (error) => error.kind === "identity-taken",
  );
});

test("a lockout carries its retry delay", async () => {
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 423,
        body: { error: "temporarily_locked", retryAfterSecs: 900 },
      }),
    }),
  );
  await assert.rejects(
    () => auth.signIn("founder@example.com", "wrong"),
    (error) => error.kind === "locked" && error.retryAfterSecs === 900,
  );
});

test("rate limiting maps to locked, not unreachable", async () => {
  // unreachable renders a retry banner, and retrying is what keeps a
  // rate-limit window open. The user has to be told to wait instead.
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 429,
        body: { error: "rate_limited", retryAfterSecs: 120 },
      }),
    }),
  );
  await assert.rejects(
    () => auth.signIn("founder@example.com", "correct horse battery"),
    (error) => error.kind === "locked" && error.retryAfterSecs === 120,
  );
});

test("a network failure maps to unreachable", async () => {
  const auth = createAuthService(
    deps({
      post: async () => {
        throw new TypeError("Failed to fetch");
      },
    }),
  );
  await assert.rejects(
    () => auth.signUp("founder@example.com", "correct horse battery"),
    (error) => error.kind === "unreachable",
  );
});

test("a 500 maps to unreachable rather than leaking a status", async () => {
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 500,
        body: { error: "internal server error" },
      }),
    }),
  );
  await assert.rejects(
    () => auth.signUp("founder@example.com", "correct horse battery"),
    (error) => error.kind === "unreachable",
  );
});

test("signIn imports the returned blob with the password", async () => {
  let imported;
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 200,
        body: {
          pubkey: "a".repeat(64),
          passwordBlob: "ncryptsec1abc",
          kdfVersion: 1,
        },
      }),
      importIdentity: async (blob, password) => {
        imported = { blob, password };
      },
    }),
  );
  await auth.signIn("founder@example.com", "correct horse battery");
  assert.deepEqual(imported, {
    blob: "ncryptsec1abc",
    password: "correct horse battery",
  });
});

test("wrong credentials map to invalid-credentials", async () => {
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 401,
        body: { error: "invalid_credentials" },
      }),
    }),
  );
  await assert.rejects(
    () => auth.signIn("founder@example.com", "wrong"),
    (error) => error.kind === "invalid-credentials",
  );
});

test("an unsupported kdf version is surfaced, not ignored", async () => {
  // A newer relay could return a version this build cannot open. Silently
  // continuing would leave the user signed in with no working key.
  let imports = 0;
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 200,
        body: {
          pubkey: "a".repeat(64),
          passwordBlob: "ncryptsec1abc",
          kdfVersion: 99,
        },
      }),
      importIdentity: async () => {
        imports += 1;
      },
    }),
  );
  await assert.rejects(
    () => auth.signIn("founder@example.com", "correct horse battery"),
    (error) => error.kind === "update-required",
  );
  assert.equal(
    imports,
    0,
    "nothing is imported when the version is unsupported",
  );
});

test("recover returns the pubkey and a reset token", async () => {
  let sent;
  const auth = createAuthService(
    deps({
      post: async (_path, body) => {
        sent = body;
        return {
          status: 200,
          body: {
            pubkey: "a".repeat(64),
            recoveryBlob: "ncryptsec1xyz",
            resetToken: "tok123",
          },
        };
      },
    }),
  );
  const result = await auth.recover(
    " Founder@Example.COM ",
    "abcde-fghjk-mnpqr-stvwx",
  );
  assert.deepEqual(result, { pubkey: "a".repeat(64), resetToken: "tok123" });
  assert.equal(sent.email, "founder@example.com");
  assert.match(sent.recoveryCodeHash, /^[0-9a-f]{64}$/);
});

test("a wrong recovery code maps to invalid-credentials", async () => {
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 401,
        body: { error: "invalid_recovery_code" },
      }),
    }),
  );
  await assert.rejects(
    () => auth.recover("founder@example.com", "ABCDE-FGHJK-MNPQR-STVWX"),
    (error) => error.kind === "invalid-credentials",
  );
});

test("recover imports the returned blob with the typed code", async () => {
  // The recovery blob is encrypted under the recovery code itself (the same
  // discipline as signUp's passwordBlob/recoveryBlob pair), so recover can
  // decrypt and import it with no new password: the recovery code is a
  // genuine second way in, not just a token that proves identity.
  let imported;
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 200,
        body: {
          pubkey: "a".repeat(64),
          recoveryBlob: "ncryptsec1xyz",
          resetToken: "tok123",
        },
      }),
      importIdentity: async (blob, password) => {
        imported = { blob, password };
      },
    }),
  );
  const result = await auth.recover(
    "founder@example.com",
    "ABCDE-FGHJK-MNPQR-STVWX",
  );
  assert.deepEqual(imported, {
    blob: "ncryptsec1xyz",
    password: "ABCDE-FGHJK-MNPQR-STVWX",
  });
  assert.deepEqual(result, { pubkey: "a".repeat(64), resetToken: "tok123" });
});

test("a recover response with no blob to open maps to unreachable", async () => {
  // Half an answer is worse than none: importing nothing would leave the
  // screen believing recovery worked while the keyring still holds whatever
  // it held before.
  let imports = 0;
  const auth = createAuthService(
    deps({
      post: async () => ({
        status: 200,
        body: { pubkey: "a".repeat(64), resetToken: "tok123" },
      }),
      importIdentity: async () => {
        imports += 1;
      },
    }),
  );
  await assert.rejects(
    () => auth.recover("founder@example.com", "ABCDE-FGHJK-MNPQR-STVWX"),
    (error) => error.kind === "unreachable",
  );
  assert.equal(imports, 0, "nothing is imported when there is no blob to open");
});
