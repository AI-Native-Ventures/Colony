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

/** Pack id to granted cents, mirroring the relay's grant column. */
const FAKE_GRANT_CENTS: Record<string, number> = {
  starter: 500,
  growth: 1_400,
  scale: 4_400,
  pro: 12_000,
  studio: 25_000,
  agency: 50_000,
  enterprise: 100_000,
};

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
      // Mirrors the relay's own table closely enough for the screen to look
      // real, and bills ZAR, since that is what every South African gateway
      // does and the case most likely to be got wrong.
      packs: async () => {
        await wait();
        return {
          currency: "ZAR" as const,
          packs: [
            {
              id: "starter",
              name: "Starter",
              zarCents: 11_900,
              usdCents: 699,
              grantNanousd: 5_000_000_000,
            },
            {
              id: "growth",
              name: "Growth",
              zarCents: 29_900,
              usdCents: 1_799,
              grantNanousd: 14_000_000_000,
            },
            {
              id: "scale",
              name: "Scale",
              zarCents: 89_900,
              usdCents: 5_499,
              grantNanousd: 44_000_000_000,
            },
            {
              id: "pro",
              name: "Pro",
              zarCents: 244_900,
              usdCents: 14_899,
              grantNanousd: 120_000_000_000,
            },
            {
              id: "studio",
              name: "Studio",
              zarCents: 508_900,
              usdCents: 30_799,
              grantNanousd: 250_000_000_000,
            },
            {
              id: "agency",
              name: "Agency",
              zarCents: 1_014_900,
              usdCents: 60_999,
              grantNanousd: 500_000_000_000,
            },
            {
              id: "enterprise",
              name: "Enterprise",
              zarCents: 2_024_900,
              usdCents: 120_999,
              grantNanousd: 1_000_000_000_000,
            },
          ],
        };
      },
      createTransaction: async (packId) => {
        await wait();
        const reference = `ref_${pending.size + 1}`;
        // Record what the pack grants, not what it costs: settlement credits
        // Credits, and the fake must not imply the two are the same number.
        const grantCents = FAKE_GRANT_CENTS[packId] ?? 500;
        pending.set(reference, grantCents);
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
