export type SignUpResult = {
  pubkey: string;
  recoveryCode: string;
};

/** Typed failures, so a screen never has to parse an error string. */
export type ScrapeFailureReason =
  | "unreachable"
  | "blocked"
  | "empty"
  | "timeout";

/** A currency a gateway bills in. Matches the relay's `Currency`. */
export type ChargeCurrency = "ZAR" | "USD";

/**
 * One top-up option.
 *
 * Prices are stated per currency, never converted. No South African gateway
 * may charge in USD, so a dollar price could only reach PayFast through an
 * exchange rate, and a rate is a currency position Colony has no business
 * holding. `grantUsdCents` is what the buyer receives either way: Credits are
 * dollar-denominated because Colony's own costs are.
 */
export type CreditPack = {
  id: string;
  name: string;
  zarCents: number;
  usdCents: number;
  grantNanousd: number;
};

/**
 * The price list, plus which currency actually applies.
 *
 * `currency` is null when payments are disabled: there is no gateway to ask,
 * so the screen shows what a pack grants without inventing a price for it.
 */
export type CreditPackList = {
  packs: CreditPack[];
  currency: ChargeCurrency | null;
};

export type ScrapeResult =
  | { ok: true; description: string; sourcePages: string[] }
  | { ok: false; reason: ScrapeFailureReason };

export type OnboardingServices = {
  auth: {
    signUp: (email: string, password: string) => Promise<SignUpResult>;
    signIn: (email: string, password: string) => Promise<{ pubkey: string }>;
    recover: (
      email: string,
      code: string,
    ) => Promise<{ pubkey: string; resetToken: string }>;
  };
  payments: {
    /**
     * What a top-up costs, fetched rather than compiled in, so a price
     * change reaches users without shipping a desktop build.
     */
    packs: () => Promise<CreditPackList>;
    /**
     * Start checkout for one pack. The client names a pack, never a price:
     * the relay looks the price up, so nothing here can undercut it.
     */
    createTransaction: (
      packId: string,
      email: string,
    ) => Promise<{ authorizationUrl: string; reference: string }>;
    verify: (reference: string) => Promise<{ paid: boolean; usdCents: number }>;
    balance: (pubkey: string) => Promise<{ usdCents: number }>;
  };
  scrape: {
    describeBusiness: (url: string) => Promise<ScrapeResult>;
  };
  invites: {
    invite: (emails: string[]) => Promise<{ sent: number }>;
  };
};
