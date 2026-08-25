// desktop/src/features/onboarding/lib/wiredScrapeService.ts
import {
  buildEditableCompanySummary,
  scanOnboardingCompanyWebsite,
} from "@/shared/api/tauriCompanyScan";
import type { OnboardingServices, ScrapeResult } from "../contracts";

/**
 * The real website read.
 *
 * `scan_onboarding_company_website` does the work: address guard, bounded
 * fetch, timeouts, and a typed outcome. This maps that outcome onto the
 * flow's contract so the screen keeps its four honest failure states instead
 * of collapsing them into one.
 *
 * It exists because the flow shipped against `contracts.fake.ts`, whose
 * describeBusiness returns a hand-written paragraph about a Johannesburg
 * workshop. In a production build that paragraph would have been shown to
 * someone as what Colony found on *their* website, and their agents would
 * have worked from it. A fake that fails loudly is survivable; one that
 * returns confident, plausible, invented text about a real business is not.
 */
export function createWiredScrapeService(): OnboardingServices["scrape"] {
  return {
    describeBusiness: async (url: string): Promise<ScrapeResult> => {
      let outcome: Awaited<ReturnType<typeof scanOnboardingCompanyWebsite>>;
      try {
        outcome = await scanOnboardingCompanyWebsite(url);
      } catch {
        // The command itself failed to run: no native bridge, or the backend
        // rejected the call. Unreachable is the honest reading.
        return { ok: false, reason: "unreachable" };
      }

      if (outcome.status !== "success") {
        // Each outcome keeps its own meaning: "invalid" is the address guard
        // refusing the URL, which is a blocked target rather than a site that
        // failed to answer.
        const reason =
          outcome.status === "timeout"
            ? "timeout"
            : outcome.status === "invalid"
              ? "blocked"
              : "unreachable";
        return { ok: false, reason };
      }

      const description = buildEditableCompanySummary(outcome.result);
      if (!description.trim()) {
        // The scan reached the site and came back with nothing readable. Say
        // so rather than handing the flow an empty description to present as
        // a finding.
        return { ok: false, reason: "empty" };
      }

      return {
        ok: true,
        description,
        sourcePages: outcome.result.pages.map((page) => page.url),
      };
    },
  };
}
