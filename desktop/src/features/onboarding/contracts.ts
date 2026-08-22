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

export type ScrapeResult =
  | { ok: true; description: string; sourcePages: string[] }
  | { ok: false; reason: ScrapeFailureReason };

export type OnboardingServices = {
  auth: {
    signUp: (email: string, password: string) => Promise<SignUpResult>;
  };
  payments: {
    /** Amount is USD cents. $5.00 is 500. Everything is USD, nothing converts. */
    createTransaction: (
      usdCents: number,
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
