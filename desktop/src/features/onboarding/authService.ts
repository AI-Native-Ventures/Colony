/**
 * The real onboarding auth service.
 *
 * Talks to the relay account routes and the local identity commands. The
 * password stays on this computer: only `deriveAuthKey`'s output and the two
 * encrypted backups are sent, and the relay stores both opaquely. Every relay
 * failure becomes an `AuthFailure`, so no screen ever sees an HTTP status or
 * parses an error string.
 *
 * See docs/superpowers/specs/2026-08-22-auth-accounts-design.md.
 */

import { deriveAuthKey, hashRecoveryCode, normaliseEmail } from "./authCrypto";
import type { OnboardingServices, PendingSignup } from "./contracts";

/**
 * Why an auth attempt failed. Screens switch on `kind` and nothing else;
 * there is deliberately no field carrying a status code or a message.
 */
export type AuthFailure =
  | { kind: "email-taken" }
  /**
   * This computer's identity is already bound to an account under a different
   * email. Signup escrows the local pubkey, so a machine that already has an
   * account cannot create a second one under a new address: the answer is to
   * sign in with the email that identity belongs to, never to retry. Common on
   * Canary, which inherits the production identity from the legacy keychain
   * service on every reset.
   */
  | { kind: "identity-taken" }
  | { kind: "invalid-credentials" }
  | { kind: "locked"; retryAfterSecs: number }
  | { kind: "unreachable" }
  | { kind: "update-required" }
  | { kind: "local-storage" }
  | { kind: "local-identity" }
  | { kind: "server" };

/**
 * Everything the service touches that a test must not. The real wiring passes
 * Tauri commands and `fetch`; tests pass fakes, so no test ever touches Tauri.
 */
export type AuthDeps = {
  post: (
    path: string,
    body: unknown,
  ) => Promise<{ status: number; body: unknown }>;
  createBackup: (password: string) => Promise<string>;
  importIdentity: (blob: string, password: string) => Promise<void>;
  /** The public half of the identity this device already generated. */
  getPubkey: () => Promise<string>;
  prepareSignup: (email: string) => Promise<PendingSignup>;
  loadPendingSignup: () => Promise<PendingSignup | null>;
  markRegistered: (attemptId: string) => Promise<PendingSignup>;
  clearPendingSignup: (attemptId: string) => Promise<void>;
  /** Discard only a prepared attempt definitively rejected by the relay. */
  discardPendingSignup: (attemptId: string) => Promise<void>;
  saveRecoveryCode: (attemptId: string) => Promise<string | null>;
};

/** The one KDF parameter set this build sends and accepts. */
const KDF_VERSION = 1;

function readString(body: unknown, field: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function readNumber(body: unknown, field: string): number | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Map a non-2xx response to its union member, keyed on the relay's typed
 * `error` string. Anything unrecognised, including a 5xx or a missing body,
 * lands on `unreachable`: the one bucket that means "retry, nothing changed".
 */
function failureFromResponse(body: unknown): AuthFailure {
  switch (readString(body, "error")) {
    case "email_taken":
      return { kind: "email-taken" };
    // The address is free but this computer's key is not. Falling through to
    // `unreachable` told the user to check a connection that was never the
    // problem, and no amount of retrying can change the answer.
    case "pubkey_taken":
      return { kind: "identity-taken" };
    case "invalid_credentials":
    case "invalid_recovery_code":
      return { kind: "invalid-credentials" };
    // Both mean "wait, then try again", and both carry how long. Rate limiting
    // must not fall through to `unreachable`: that tells the user to retry, and
    // retrying is what keeps the window open.
    case "temporarily_locked":
    case "rate_limited": {
      const secs = readNumber(body, "retryAfterSecs");
      return {
        kind: "locked",
        retryAfterSecs: secs === undefined ? 0 : Math.max(0, Math.floor(secs)),
      };
    }
    default:
      return { kind: "server" };
  }
}

/** Pass typed failures through; turn anything else into `unreachable`. */
function asAuthFailure(thrown: unknown): AuthFailure {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "kind" in thrown &&
    typeof (thrown as { kind: unknown }).kind === "string"
  ) {
    return thrown as AuthFailure;
  }
  return { kind: "unreachable" };
}

function unreachable(): AuthFailure {
  return { kind: "unreachable" };
}

async function guard<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (thrown) {
    throw asAuthFailure(thrown);
  }
}

/**
 * Build the service the onboarding flow consumes.
 *
 * Signup derives the auth key, encrypts the saved identity twice (once under
 * the password, once under the recovery code), and posts both. Signin derives
 * the auth key, posts it, and hands the returned backup to the identity
 * command for decryption on this computer. Recovery hashes the typed code,
 * imports the returned recovery blob under that code (it is a second way in),
 * and returns the reset token the password reset consumes.
 */
export function createAuthService(deps: AuthDeps): OnboardingServices["auth"] {
  return {
    pendingSignup: deps.loadPendingSignup,
    saveRecovery: deps.saveRecoveryCode,
    acknowledgeRecovery: deps.clearPendingSignup,
    signUp: (email, password) =>
      guard(async () => {
        let pending: PendingSignup;
        try {
          pending = await deps.prepareSignup(normaliseEmail(email));
        } catch {
          throw { kind: "local-storage" } satisfies AuthFailure;
        }
        const { recoveryCode, pubkey, attemptId } = pending;
        if (pending.phase === "registered")
          return { pubkey, recoveryCode, attemptId };
        let authKey: string;
        let passwordBlob: string;
        let recoveryBlob: string;
        try {
          if ((await deps.getPubkey()) !== pubkey)
            throw new Error("Identity changed");
          authKey = await deriveAuthKey(email, password);
          passwordBlob = await deps.createBackup(password);
          recoveryBlob = await deps.createBackup(recoveryCode);
        } catch {
          throw { kind: "local-identity" } satisfies AuthFailure;
        }
        const response = await deps.post("/api/accounts/signup", {
          email: normaliseEmail(email),
          pubkey,
          authKey,
          passwordBlob,
          recoveryBlob,
          recoveryCodeHash: await hashRecoveryCode(recoveryCode),
          kdfVersion: KDF_VERSION,
        });
        if (!isOk(response.status)) {
          const failure = failureFromResponse(response.body);
          // A successful POST can lose its response. Only the registered code
          // proves this is our attempt, rather than somebody else's account.
          if (
            failure.kind !== "email-taken" &&
            failure.kind !== "identity-taken"
          )
            throw failure;
          const recovered = await deps.post("/api/accounts/recover", {
            email: normaliseEmail(email),
            recoveryCodeHash: await hashRecoveryCode(recoveryCode),
          });
          // A typed 401 proves this code did not register that email. Only
          // this definitive rejection releases the prepared email so the
          // founder can correct it. Network/5xx/locked/partial replies retain
          // the original recovery checkpoint for an uncertain accepted POST.
          if (
            response.status === 409 &&
            recovered.status === 401 &&
            readString(recovered.body, "error") === "invalid_recovery_code"
          ) {
            try {
              await deps.discardPendingSignup(attemptId);
            } catch {
              throw { kind: "local-storage" } satisfies AuthFailure;
            }
            throw failure;
          }
          if (
            !isOk(recovered.status) ||
            readString(recovered.body, "pubkey") !== pubkey ||
            !readString(recovered.body, "recoveryBlob")
          )
            throw failure;
          // Recovery proves this attempt's account, but does not install the
          // password typed on this retry. Verify that exact password too.
          const signedIn = await deps.post("/api/accounts/signin", {
            email: normaliseEmail(email),
            authKey,
          });
          if (!isOk(signedIn.status)) throw failureFromResponse(signedIn.body);
          if (
            readString(signedIn.body, "pubkey") !== pubkey ||
            !readString(signedIn.body, "passwordBlob")
          ) {
            throw { kind: "server" } satisfies AuthFailure;
          }
        } else if (readString(response.body, "pubkey") !== pubkey) {
          throw { kind: "server" } satisfies AuthFailure;
        }
        try {
          await deps.markRegistered(attemptId);
        } catch {
          throw { kind: "local-storage" } satisfies AuthFailure;
        }
        return { pubkey, recoveryCode, attemptId };
      }),
    signIn: (email, password) =>
      guard(async () => {
        const authKey = await deriveAuthKey(email, password);
        const response = await deps.post("/api/accounts/signin", {
          email: normaliseEmail(email),
          authKey,
        });
        if (!isOk(response.status)) {
          throw failureFromResponse(response.body);
        }
        const pubkey = readString(response.body, "pubkey");
        const storedBlob = readString(response.body, "passwordBlob");
        const kdfVersion = readNumber(response.body, "kdfVersion");
        if (pubkey === undefined || storedBlob === undefined) {
          throw unreachable();
        }
        if (kdfVersion !== KDF_VERSION) {
          // A newer relay may hold the identity at a format this build cannot
          // open. Continuing would sign the user in with nothing that works.
          throw { kind: "update-required" } satisfies AuthFailure;
        }
        await deps.importIdentity(storedBlob, password);
        return { pubkey };
      }),
    recover: (email, code) =>
      guard(async () => {
        const recoveryCodeHash = await hashRecoveryCode(code);
        const response = await deps.post("/api/accounts/recover", {
          email: normaliseEmail(email),
          recoveryCodeHash,
        });
        if (!isOk(response.status)) {
          throw failureFromResponse(response.body);
        }
        const pubkey = readString(response.body, "pubkey");
        const resetToken = readString(response.body, "resetToken");
        const recoveryBlob = readString(response.body, "recoveryBlob");
        // The recovery blob is encrypted under the recovery code itself, the
        // same discipline as signUp's passwordBlob/recoveryBlob pair, so the
        // typed code is a genuine second way in rather than a token that
        // merely proves identity. Half an answer (no blob to open) would leave
        // the keyring holding whatever it held before while a screen reports
        // success, so that maps to unreachable like any other unusable reply.
        if (
          pubkey === undefined ||
          resetToken === undefined ||
          recoveryBlob === undefined
        ) {
          throw unreachable();
        }
        await deps.importIdentity(recoveryBlob, code);
        return { pubkey, resetToken };
      }),
  };
}
