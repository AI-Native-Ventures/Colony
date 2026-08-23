// desktop/src/features/onboarding/lib/wiredPaymentsService.ts
import { getRelayHttpUrl, signRelayEvent } from "@/shared/api/tauri";
import type { OnboardingServices } from "../contracts";
import { createPaymentsService } from "../paymentsService";

/** NIP-98 HTTP auth. */
const NIP98_KIND = 27235;

/** sha256 of the exact body, for the relay's required `payload` tag. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * How long one payments call may take.
 *
 * Initialize opens a real charge attempt at the gateway, and verify is
 * polled while someone waits on a hosted checkout tab, so neither should
 * hang the screen indefinitely.
 */
const PAYMENTS_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The real payments transport.
 *
 * `paymentsService.ts` already holds every rule that matters — the minimum
 * top-up, the typed failures, the "unpaid just means keep waiting" reading of
 * verify. It was written against an injected `post` and never given a real
 * one, so the flow ran on `contracts.fake.ts`: a checkout URL that goes
 * nowhere and a balance that was never charged.
 *
 * This supplies that transport, nothing more. Which gateway actually runs is
 * the relay's decision (`COLONY_PAYMENT_PROVIDER`), so switching between
 * PayFast and Paystack is a relay env change with no desktop release.
 */
export function createWiredPaymentsService(): OnboardingServices["payments"] {
  return createPaymentsService({
    post: async (path, body) => {
      const base = await getRelayHttpUrl();
      const url = `${base.replace(/\/+$/, "")}${path}`;
      const serialized = JSON.stringify(body ?? {});
      // The relay verifies the `u` tag against the exact URL and requires a
      // `payload` tag carrying sha256(body) for signed POSTs, so both are
      // finalized before signing.
      const authEvent = await signRelayEvent({
        kind: NIP98_KIND,
        content: "",
        tags: [
          ["u", url],
          ["method", "POST"],
          ["payload", await sha256Hex(serialized)],
          ["nonce", crypto.randomUUID()],
        ],
      });
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Nostr ${btoa(JSON.stringify(authEvent))}`,
          "Content-Type": "application/json",
        },
        body: serialized,
        signal: AbortSignal.timeout(PAYMENTS_REQUEST_TIMEOUT_MS),
      });
      // The service reads typed failures out of the body, so a non-JSON error
      // page becomes an empty object rather than a thrown parse error.
      const parsed: unknown = await response.json().catch(() => ({}));
      return { status: response.status, body: parsed };
    },
  });
}
