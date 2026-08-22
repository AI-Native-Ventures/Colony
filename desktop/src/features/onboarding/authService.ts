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

import {
  deriveAuthKey,
  generateRecoveryCode,
  hashRecoveryCode,
  normaliseEmail,
} from "./authCrypto";
import type { OnboardingServices } from "./contracts";

/**
 * Why an auth attempt failed. Screens switch on `kind` and nothing else;
 * there is deliberately no field carrying a status code or a message.
 */
export type AuthFailure =
  | { kind: "email-taken" }
  | { kind: "invalid-credentials" }
  | { kind: "locked"; retryAfterSecs: number }
  | { kind: "unreachable" }
  | { kind: "update-required" };

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
  /** Overrides recovery-code generation. Tests only; production omits it. */
  generateCode?: () => string;
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
    case "invalid_credentials":
    case "invalid_recovery_code":
      return { kind: "invalid-credentials" };
    case "temporarily_locked": {
      const secs = readNumber(body, "retryAfterSecs");
      return {
        kind: "locked",
        retryAfterSecs: secs === undefined ? 0 : Math.max(0, Math.floor(secs)),
      };
    }
    default:
      return { kind: "unreachable" };
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
 * command for decryption on this computer. Recovery hashes the typed code and
 * returns the reset token the password reset consumes.
 */
export function createAuthService(deps: AuthDeps): OnboardingServices["auth"] {
  return {
    signUp: (email, password) =>
      guard(async () => {
        const recoveryCode = deps.generateCode
          ? deps.generateCode()
          : generateRecoveryCode();
        const authKey = await deriveAuthKey(email, password);
        const passwordBlob = await deps.createBackup(password);
        const recoveryBlob = await deps.createBackup(recoveryCode);
        const pubkey = await deps.getPubkey();
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
          throw failureFromResponse(response.body);
        }
        const created = readString(response.body, "pubkey");
        if (created === undefined) {
          throw unreachable();
        }
        return { pubkey: created, recoveryCode };
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
        if (pubkey === undefined || resetToken === undefined) {
          throw unreachable();
        }
        return { pubkey, resetToken };
      }),
  };
}
