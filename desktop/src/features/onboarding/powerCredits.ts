import { openUrl } from "@/shared/api/nativeBridge";
import { getColonyCreditsAccount } from "@/shared/api/tauriProvisionedCredits";
import {
  createCreditsCheckout,
  isFirstJobCheckoutAttempt,
  type FirstJobCheckoutAttempt,
} from "./firstJobCredits";
import { assertFirstJobScope } from "./firstJobScope";
import { withFirstJobBrowserLock } from "./firstJobStorage";
import { createWiredPaymentsService } from "./lib/wiredPaymentsService";

/** Funding setup belongs to an owner and business, before any thread exists. */
export type PowerCreditsScope = { ownerPubkey: string; relayUrl: string };

/** Validate the exact native connection; never invent a thread for checkout. */
export function snapshotPowerCreditsScope(
  scope: PowerCreditsScope,
): PowerCreditsScope {
  const relay = new URL(scope.relayUrl);
  if (
    !/^[a-f0-9]{64}$/.test(scope.ownerPubkey) ||
    !["ws:", "wss:"].includes(relay.protocol) ||
    relay.username ||
    relay.password ||
    relay.hash ||
    scope.relayUrl.length > 2048
  )
    throw new Error("This business connection changed. Reopen setup.");
  return Object.freeze({
    ownerPubkey: scope.ownerPubkey,
    relayUrl: scope.relayUrl,
  });
}

/** Durable key excludes credentials and prevents cross-owner/business reuse. */
export function powerCheckoutKey(scope: PowerCreditsScope): string {
  const captured = snapshotPowerCreditsScope(scope);
  return (
    "colony.power-checkout.v1:" +
    JSON.stringify([captured.ownerPubkey, captured.relayUrl])
  );
}

/** Shared checkout recovery store; an unreadable attempt must not become absent. */
export function createPowerCheckoutStore(
  storage: Pick<Storage, "getItem" | "setItem">,
) {
  return {
    read(scope: PowerCreditsScope): FirstJobCheckoutAttempt | null {
      const raw = storage.getItem(powerCheckoutKey(scope));
      if (raw === null) return null;
      try {
        if (raw.length > 16_384) throw new Error("Oversized checkout");
        const saved = JSON.parse(raw);
        if (
          saved.version !== 1 ||
          powerCheckoutKey(saved.scope) !== powerCheckoutKey(scope) ||
          !isFirstJobCheckoutAttempt(saved.attempt)
        ) {
          throw new Error("Invalid checkout");
        }
        return saved.attempt;
      } catch {
        throw new Error(
          "Your saved checkout could not be read. No new payment has been started.",
        );
      }
    },
    write(scope: PowerCreditsScope, attempt: FirstJobCheckoutAttempt) {
      if (!isFirstJobCheckoutAttempt(attempt))
        throw new Error("This checkout could not be saved.");
      const key = powerCheckoutKey(scope);
      const raw = JSON.stringify({ version: 1, scope, attempt });
      storage.setItem(key, raw);
      if (storage.getItem(key) !== raw)
        throw new Error("This checkout could not be saved.");
    },
  };
}

/** Reuse the same checked payment flow as first-job funding, without starting work. */
export function createPowerCredits(inputScope: PowerCreditsScope) {
  const scope = snapshotPowerCreditsScope(inputScope);
  const store = createPowerCheckoutStore(window.localStorage);
  const credits = createCreditsCheckout({
    snapshotScope: snapshotPowerCreditsScope,
    scopeKey: powerCheckoutKey,
    assertCurrent: assertFirstJobScope,
    payments: createWiredPaymentsService(scope),
    async readAvailableCredits(captured: PowerCreditsScope) {
      await assertFirstJobScope(captured);
      const account = await getColonyCreditsAccount();
      await assertFirstJobScope(captured);
      if (
        account.currency !== "USD" ||
        !/^-?\d{1,40}$/.test(account.available_balance_nanousd)
      ) {
        throw new Error("Your available credits could not be read.");
      }
      return BigInt(account.available_balance_nanousd);
    },
    openUrl,
    readAttempt: async (captured) => store.read(captured),
    writeAttempt: async (captured, attempt) => store.write(captured, attempt),
    withAttemptLock: (captured, work) =>
      withFirstJobBrowserLock(powerCheckoutKey(captured), work),
  });
  return { scope, store, credits };
}
