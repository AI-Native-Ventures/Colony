import type { CreditPackList, OnboardingServices } from "./contracts";
import {
  firstJobScopeKey,
  snapshotFirstJobScope,
  type FirstJobScope,
} from "./firstJobStart";

/** A receipt request contains a pack ID and email, never a client-set price. */
export type FirstJobCheckoutInput = { packId: string; email: string };

/**
 * Retry data stored in the existing scoped onboarding attempt. Initializing is
 * written before the request; after interruption it means an unknown outcome,
 * never permission to create a second payment. No card or authentication data.
 */
export type FirstJobCheckoutAttempt =
  | (FirstJobCheckoutInput & { phase: "initializing" })
  | (FirstJobCheckoutInput & {
      phase: "ready";
      reference: string;
      authorizationUrl: string;
    });

/** Opening a browser or finding an existing attempt never means payment landed. */
export type FirstJobCheckoutResult =
  | { kind: "initialization-uncertain" }
  | {
      kind: "opened" | "existing" | "open-failed";
      reference: string;
      authorizationUrl: string;
    };

/** Funds only enable a separate, explicit Start action; this never dispatches. */
export type FirstJobFundingResult =
  | {
      kind: "funded" | "waiting";
      paid: boolean | null;
      availableNanousd: bigint;
    }
  | { kind: "initialization-uncertain"; availableNanousd: bigint };

/** Existing payment/native services plus durable scope-bound attempt adapters. */
export type FirstJobCreditsDependencies = {
  payments: Pick<
    OnboardingServices["payments"],
    "packs" | "createTransaction" | "verify"
  >;
  assertCurrent(scope: FirstJobScope): Promise<void>;
  readAvailableCredits(scope: FirstJobScope): Promise<bigint>;
  openUrl(url: string): Promise<unknown>;
  readAttempt(scope: FirstJobScope): Promise<FirstJobCheckoutAttempt | null>;
  writeAttempt(
    scope: FirstJobScope,
    attempt: FirstJobCheckoutAttempt,
  ): Promise<void>;
  /** Must exclude other windows, not just calls on this controller instance. */
  withAttemptLock<T>(
    scope: FirstJobScope,
    action: () => Promise<T>,
  ): Promise<T>;
};

/** The small funding surface used by the in-thread setup suggestion. */
export type FirstJobCreditsController = {
  loadPacks(scope: FirstJobScope): Promise<CreditPackList>;
  begin(
    scope: FirstJobScope,
    input: FirstJobCheckoutInput,
  ): Promise<FirstJobCheckoutResult>;
  reopen(scope: FirstJobScope): Promise<FirstJobCheckoutResult>;
  check(scope: FirstJobScope): Promise<FirstJobFundingResult>;
};

function checkoutInput(input: FirstJobCheckoutInput): FirstJobCheckoutInput {
  const packId = typeof input.packId === "string" ? input.packId.trim() : "";
  const email =
    typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (!packId || packId.length > 256)
    throw new Error("Choose an available credit pack.");
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Enter a valid receipt email for checkout.");
  return { packId, email };
}

function validCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8_192) return false;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function readyAttempt(
  input: FirstJobCheckoutInput,
  started: { reference: string; authorizationUrl: string },
): Extract<FirstJobCheckoutAttempt, { phase: "ready" }> {
  if (
    typeof started.reference !== "string" ||
    !started.reference.trim() ||
    started.reference.length > 512 ||
    !validCheckoutUrl(started.authorizationUrl)
  )
    throw new Error(
      "The checkout reference could not be read. Check your credits before trying again.",
    );
  return Object.freeze({
    ...input,
    phase: "ready",
    reference: started.reference,
    authorizationUrl: started.authorizationUrl,
  });
}

function checkedAttempt(
  attempt: FirstJobCheckoutAttempt | null,
): FirstJobCheckoutAttempt | null {
  if (attempt === null) return null;
  if (typeof attempt !== "object" || !attempt)
    throw new Error("The saved checkout could not be read.");
  const input = checkoutInput(attempt);
  if (attempt.phase === "initializing")
    return Object.freeze({ ...input, phase: "initializing" });
  if (attempt.phase === "ready") return readyAttempt(input, attempt);
  throw new Error("The saved checkout could not be read.");
}

/** Validate scoped persistence before presenting or reopening a saved checkout. */
export function isFirstJobCheckoutAttempt(
  value: unknown,
): value is FirstJobCheckoutAttempt {
  if (!value) return false;
  try {
    return checkedAttempt(value as FirstJobCheckoutAttempt) !== null;
  } catch {
    return false;
  }
}

/**
 * Control funding without adding a payment store or starting work. Every write
 * and browser handoff is guarded after the preceding asynchronous operation.
 * Persistence/locking adapters must also bind the owner and relay internally.
 */
export function createFirstJobCredits(
  dependencies: FirstJobCreditsDependencies,
): FirstJobCreditsController {
  const inFlight = new Map<string, Promise<unknown>>();

  async function current<T>(
    scope: FirstJobScope,
    action: () => Promise<T>,
  ): Promise<T> {
    await dependencies.assertCurrent(scope);
    const result = await action();
    await dependencies.assertCurrent(scope);
    return result;
  }

  function locked<T>(
    inputScope: FirstJobScope,
    operation: string,
    action: (scope: FirstJobScope) => Promise<T>,
  ): Promise<T> {
    let scope: FirstJobScope;
    try {
      scope = snapshotFirstJobScope(inputScope);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = `${operation}:${firstJobScopeKey(scope)}`;
    const pending = inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const result = current(scope, () =>
      dependencies.withAttemptLock(scope, () =>
        current(scope, () => action(scope)),
      ),
    ).finally(() => inFlight.delete(key));
    inFlight.set(key, result);
    return result;
  }

  async function read(scope: FirstJobScope) {
    return checkedAttempt(
      await current(scope, () => dependencies.readAttempt(scope)),
    );
  }

  async function open(
    scope: FirstJobScope,
    attempt: Extract<FirstJobCheckoutAttempt, { phase: "ready" }>,
  ): Promise<FirstJobCheckoutResult> {
    await dependencies.assertCurrent(scope);
    let opened = false;
    try {
      await dependencies.openUrl(attempt.authorizationUrl);
      opened = true;
    } catch {
      // The reference remains valid even when the native browser cannot open.
    }
    await dependencies.assertCurrent(scope);
    return {
      kind: opened ? "opened" : "open-failed",
      reference: attempt.reference,
      authorizationUrl: attempt.authorizationUrl,
    };
  }

  return {
    async loadPacks(inputScope) {
      const scope = snapshotFirstJobScope(inputScope);
      return current(scope, () => dependencies.payments.packs());
    },
    begin(scope, rawInput) {
      let input: FirstJobCheckoutInput;
      try {
        input = checkoutInput(rawInput);
      } catch (error) {
        return Promise.reject(error);
      }
      return locked(scope, "begin", async (captured) => {
        const existing = await read(captured);
        if (existing?.phase === "initializing")
          return { kind: "initialization-uncertain" };
        if (existing?.phase === "ready") {
          return {
            kind: "existing",
            reference: existing.reference,
            authorizationUrl: existing.authorizationUrl,
          };
        }
        const catalogue = await current(captured, () =>
          dependencies.payments.packs(),
        );
        if (
          !catalogue.currency ||
          !catalogue.packs.some((pack) => pack.id === input.packId)
        )
          throw new Error(
            "Prices for this credit pack are unavailable. Reload prices and try again.",
          );
        await current(captured, () =>
          dependencies.writeAttempt(captured, {
            phase: "initializing",
            ...input,
          }),
        );

        await dependencies.assertCurrent(captured);
        let started: { reference: string; authorizationUrl: string };
        try {
          started = await dependencies.payments.createTransaction(
            input.packId,
            input.email,
          );
        } catch {
          // The relay may have initialized payment despite a lost response.
          // Retain the durable claim and never automatically initialize again.
          await dependencies.assertCurrent(captured);
          return { kind: "initialization-uncertain" };
        }
        await dependencies.assertCurrent(captured);
        const attempt = readyAttempt(input, started);
        await current(captured, () =>
          dependencies.writeAttempt(captured, attempt),
        );
        return open(captured, attempt);
      });
    },
    reopen(scope) {
      return locked(scope, "reopen", async (captured) => {
        const attempt = await read(captured);
        if (attempt?.phase === "initializing")
          return { kind: "initialization-uncertain" };
        if (!attempt)
          throw new Error(
            "There is no checkout to reopen. Choose a credit pack first.",
          );
        return open(captured, attempt);
      });
    },
    check(scope) {
      return locked(scope, "check", async (captured) => {
        const attempt = await read(captured);
        let paid: boolean | null = null;
        if (attempt?.phase === "ready") {
          const verified = await current(captured, () =>
            dependencies.payments.verify(attempt.reference),
          );
          if (typeof verified.paid !== "boolean")
            throw new Error("The payment could not be verified. Try again.");
          paid = verified.paid;
        }
        const availableNanousd = await current(captured, () =>
          dependencies.readAvailableCredits(captured),
        );
        if (typeof availableNanousd !== "bigint")
          throw new Error("Available credits could not be read. Try again.");
        if (availableNanousd > 0n)
          return { kind: "funded", paid, availableNanousd };
        if (attempt?.phase === "initializing")
          return { kind: "initialization-uncertain", availableNanousd };
        return { kind: "waiting", paid, availableNanousd };
      });
    },
  };
}
