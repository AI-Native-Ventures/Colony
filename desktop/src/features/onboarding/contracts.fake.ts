import type { OnboardingServices, ScrapeFailureReason } from "./contracts";

export type FakeOptions = {
  scrapeOutcome?: "ok" | ScrapeFailureReason;
  paymentOutcome?: "paid" | "abandoned";
  delayMs?: number;
};

const SAMPLE_DESCRIPTION =
  "Rosebank Auto Care is an independent vehicle workshop in Johannesburg. " +
  "You handle servicing, diagnostics and repairs for private owners and " +
  "small fleets, with a 48 hour turnaround on most jobs.";

/**
 * Hand-written fakes, not mocks: the flow is built and tested against these
 * until the real auth, payments, scrape and invite services exist.
 */
export function createFakeServices(
  options: FakeOptions = {},
): OnboardingServices {
  const {
    scrapeOutcome = "ok",
    paymentOutcome = "paid",
    delayMs = 0,
  } = options;
  const wait = () =>
    delayMs ? new Promise((resolve) => setTimeout(resolve, delayMs)) : null;

  let balanceCents = 0;
  const pending = new Map<string, number>();

  return {
    auth: {
      signUp: async (email) => {
        await wait();
        return {
          pubkey: `fake-${email}`,
          recoveryCode: "TRAIL-9F2K-4QD8-MZ71",
        };
      },
      signIn: async (email) => {
        await wait();
        return { pubkey: `fake-${email}` };
      },
      recover: async (email) => {
        await wait();
        return { pubkey: `fake-${email}`, resetToken: "fake-reset-token" };
      },
    },
    payments: {
      createTransaction: async (usdCents) => {
        await wait();
        const reference = `ref_${pending.size + 1}`;
        pending.set(reference, usdCents);
        return {
          authorizationUrl: `https://checkout.example/${reference}`,
          reference,
        };
      },
      verify: async (reference) => {
        await wait();
        const amount = pending.get(reference) ?? 0;
        if (paymentOutcome === "abandoned") return { paid: false, usdCents: 0 };
        balanceCents += amount;
        return { paid: true, usdCents: amount };
      },
      balance: async () => {
        await wait();
        return { usdCents: balanceCents };
      },
    },
    scrape: {
      describeBusiness: async () => {
        await wait();
        if (scrapeOutcome === "ok") {
          return {
            ok: true,
            description: SAMPLE_DESCRIPTION,
            sourcePages: ["/", "/services"],
          };
        }
        return { ok: false, reason: scrapeOutcome };
      },
    },
    invites: {
      invite: async (emails) => {
        await wait();
        return { sent: emails.length };
      },
    },
  };
}
