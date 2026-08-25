/**
 * The real onboarding payments service.
 *
 * Hands the user a hosted checkout URL and watches for the payment to land.
 * Colony never sees card details: the gateway hosts the checkout page, so all
 * this service ever sends is a pack id and a receipt email. It sends no
 * price: the relay prices the pack, because a client that could name its own
 * price could name zero. Every relay failure becomes a `PaymentsFailure`, so
 * no screen ever sees an HTTP status or parses an error string.
 *
 * See docs/superpowers/specs/2026-08-22-paystack-topups-design.md.
 */

import { normaliseEmail } from "./authCrypto";
import type {
  CreditPack,
  CreditPackList,
  OnboardingServices,
} from "./contracts";

/**
 * Why a payment attempt failed. Screens switch on `kind` and nothing else;
 * there is deliberately no field carrying a status code or a message. There
 * is no "payment declined" kind on purpose: a declined card never reaches
 * this service, because the decline happens on the gateway's page and shows
 * up here only as an unpaid answer from `verify`.
 *
 * `unknown-pack` means the client offered an id the relay does not sell,
 * which is a stale build rather than anything the user did.
 */
export type PaymentsFailure =
  | { kind: "unknown-pack" }
  | { kind: "locked"; retryAfterSecs: number }
  | { kind: "unreachable" };

/**
 * Everything the service touches that a test must not. The real wiring passes
 * a signing `fetch`; tests pass fakes, so no test ever touches Tauri.
 */
export type PaymentsDeps = {
  post: (
    path: string,
    body: unknown,
  ) => Promise<{ status: number; body: unknown }>;
  /** Unauthenticated read for the public price list. */
  get: (path: string) => Promise<{ status: number; body: unknown }>;
};

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

function readBoolean(body: unknown, field: string): boolean | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "boolean" ? value : undefined;
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Map a non-2xx response to its union member, keyed on the relay's typed
 * `error` string. Anything unrecognised, including a 5xx or a missing body,
 * lands on `unreachable`: the one bucket that means "retry, nothing changed".
 */
function failureFromResponse(body: unknown): PaymentsFailure {
  switch (readString(body, "error")) {
    case "unknown_pack":
      return { kind: "unknown-pack" };
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
      return { kind: "unreachable" };
  }
}

/** Pass typed failures through; turn anything else into `unreachable`. */
function asPaymentsFailure(thrown: unknown): PaymentsFailure {
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "kind" in thrown &&
    typeof (thrown as { kind: unknown }).kind === "string"
  ) {
    return thrown as PaymentsFailure;
  }
  return { kind: "unreachable" };
}

function unreachable(): PaymentsFailure {
  return { kind: "unreachable" };
}

/**
 * Parse the price list, refusing anything partial.
 *
 * Strict on purpose: a pack missing its price would render as a blank or a
 * NaN next to a Pay button, and a pack missing its grant would promise
 * nothing. One bad entry rejects the whole list, because showing some of a
 * price list is worse than showing none of it.
 *
 * `currency` is legitimately absent when payments are disabled, so that alone
 * is not a parse failure.
 */
function readPacks(body: unknown): CreditPackList | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = (body as Record<string, unknown>).packs;
  if (!Array.isArray(raw)) return undefined;
  const packs: CreditPack[] = [];
  for (const entry of raw) {
    const id = readString(entry, "id");
    const name = readString(entry, "name");
    const zarCents = readNumber(entry, "zarCents");
    const usdCents = readNumber(entry, "usdCents");
    const grantNanousd = readNumber(entry, "grantNanousd");
    if (
      id === undefined ||
      name === undefined ||
      zarCents === undefined ||
      usdCents === undefined ||
      grantNanousd === undefined
    ) {
      return undefined;
    }
    // A non-positive price would be a free or negative sale; a non-positive
    // grant would charge for nothing. Neither is a state to render.
    if (zarCents <= 0 || usdCents <= 0 || grantNanousd <= 0) return undefined;
    packs.push({ id, name, zarCents, usdCents, grantNanousd });
  }
  const currency = readString(body, "currency");
  if (currency !== undefined && currency !== "ZAR" && currency !== "USD") {
    return undefined;
  }
  return { packs, currency: currency ?? null };
}

async function guard<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (thrown) {
    throw asPaymentsFailure(thrown);
  }
}

/**
 * Build the service the onboarding flow consumes.
 *
 * `packs` reads the price list. `createTransaction` names a pack and hands
 * back the checkout URL to open in the system browser. `verify`
 * reads our own record of one payment; it never moves money, so an unpaid
 * answer just means keep waiting. `balance` answers with what the workspace
 * already holds, so a payer whose confirmation is slow is never stranded.
 */
export function createPaymentsService(
  deps: PaymentsDeps,
): OnboardingServices["payments"] {
  return {
    packs: () =>
      guard(async () => {
        const response = await deps.get("/api/payments/packs");
        if (!isOk(response.status)) {
          throw failureFromResponse(response.body);
        }
        const packs = readPacks(response.body);
        if (packs === undefined) {
          throw unreachable();
        }
        return packs;
      }),
    // The pack id is all that travels. A price in this body would be a price
    // the client could choose, and a client that can choose a price can
    // choose zero.
    createTransaction: (packId, email) =>
      guard(async () => {
        const response = await deps.post("/api/payments/initialize", {
          packId,
          email: normaliseEmail(email),
        });
        if (!isOk(response.status)) {
          throw failureFromResponse(response.body);
        }
        const authorizationUrl = readString(response.body, "authorizationUrl");
        const reference = readString(response.body, "reference");
        if (authorizationUrl === undefined || reference === undefined) {
          throw unreachable();
        }
        return { authorizationUrl, reference };
      }),
    verify: (reference) =>
      guard(async () => {
        const response = await deps.post("/api/payments/verify", { reference });
        if (!isOk(response.status)) {
          throw failureFromResponse(response.body);
        }
        const paid = readBoolean(response.body, "paid");
        if (paid === undefined) {
          throw unreachable();
        }
        // An unpaid answer carries no amount yet; zero is only meaningful
        // alongside `paid: false`.
        const usdCents = readNumber(response.body, "usdCents") ?? 0;
        return { paid, usdCents };
      }),
    balance: () =>
      guard(async () => {
        // The pubkey travels in the request's signature at the wiring layer,
        // exactly as it does for initialize and verify, so the body is empty.
        const response = await deps.post("/api/payments/balance", {});
        if (!isOk(response.status)) {
          throw failureFromResponse(response.body);
        }
        const usdCents = readNumber(response.body, "usdCents");
        if (usdCents === undefined) {
          throw unreachable();
        }
        return { usdCents };
      }),
  };
}
