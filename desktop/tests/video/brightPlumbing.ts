import { firstJobStarters } from "../../src/features/onboarding/firstJobStarters";

/** The sample owner and business every user-video screen shows: the launch film's Bright Plumbing. */
export const OWNER = {
  name: "Sipho Mokoena",
  email: "sipho@brightplumbing.co.za",
} as const;

export const BUSINESS = {
  name: "Bright Plumbing",
  website: "brightplumbing.co.za",
  summary:
    "Bright Plumbing fixes leaks, drains and geysers for homes and offices across Sandton and Rosebank, with same-day call-outs and upfront prices.",
} as const;

/**
 * The credit packs exactly as the server sells them on main
 * (`crates/buzz-relay/src/credit_packs.rs`), so the prices on screen are real.
 */
export const CREDIT_PACKS = [
  {
    id: "starter",
    name: "Starter",
    zarCents: 11_900,
    usdCents: 699,
    grantUsdCents: 500,
  },
  {
    id: "growth",
    name: "Growth",
    zarCents: 29_900,
    usdCents: 1_799,
    grantUsdCents: 1_400,
  },
  {
    id: "scale",
    name: "Scale",
    zarCents: 89_900,
    usdCents: 5_499,
    grantUsdCents: 4_400,
  },
  {
    id: "pro",
    name: "Pro",
    zarCents: 244_900,
    usdCents: 14_899,
    grantUsdCents: 12_000,
  },
  {
    id: "studio",
    name: "Studio",
    zarCents: 508_900,
    usdCents: 30_799,
    grantUsdCents: 25_000,
  },
  {
    id: "agency",
    name: "Agency",
    zarCents: 1_014_900,
    usdCents: 60_999,
    grantUsdCents: 50_000,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    zarCents: 2_024_900,
    usdCents: 120_999,
    grantUsdCents: 100_000,
  },
].map(({ grantUsdCents, ...pack }) => ({
  ...pack,
  grantNanousd: grantUsdCents * 10_000_000,
}));

/** The writer the first job is handed to. */
export const WORKER_NAME = "Lerato";

/** The app's own first-job starters for the sample business. */
export const [CAPTIONS_STARTER, CLIENTS_STARTER] = firstJobStarters(
  BUSINESS.name,
);

/** Thabo's email from the launch film, as the outreach card shows it. */
export const OUTREACH = {
  business: "Grayston Office Park",
  to: "thabo@graystonofficepark.co.za",
  subject: "A plumbing partner for Grayston Office Park",
  body: [
    "Hi Thabo,",
    "",
    "Bright Plumbing looks after office parks across Sandton. We would like to be your on-call plumber: one contract, same-day call-outs. Could we meet for 15 minutes next week?",
    "",
    "Sipho",
  ].join("\n"),
} as const;

/** What the writer posts back in the job's thread: drafts, waiting for review. */
export const DRAFTS_REPLY = [
  "Here are five Instagram caption drafts for Bright Plumbing, each with a matching visual brief. They are ready for your review; nothing has been posted.",
  "",
  "1. Leak under the sink? We fix it today, with the price agreed before we start.",
  "2. Winter is coming. Book a geyser check before the cold does it for you.",
  "3. Blocked drain at the office? Same-day call-outs across Sandton and Rosebank.",
  "4. Meet the team behind Bright Plumbing: licensed, insured and on time.",
  "5. A tidy job, every time. Here is what our customers say.",
].join("\n");
