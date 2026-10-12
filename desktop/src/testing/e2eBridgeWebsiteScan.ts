/** The onboarding website read (`scan_onboarding_company_website`) for the synthetic E2E transport. */

type RawEvidence = { value: string; sourceUrl?: string; source_url?: string };

type RawPageEvidence = {
  url: string;
  title?: RawEvidence | null;
  description?: RawEvidence | null;
  headings?: string[];
  text: string;
};

/** What the native command returns: a read of the site, or why it failed. */
export type MockCompanyWebsiteScan =
  | {
      status: "success";
      result: {
        requestedUrl?: string;
        requested_url?: string;
        canonicalUrl?: string;
        canonical_url?: string;
        pages: RawPageEvidence[];
        warnings: string[];
      };
    }
  | { status: "invalid" | "failed" | "timeout"; message: string };

/**
 * The configured read, or the same unsupported-command error the bridge threw
 * before this fixture existed, so specs that never set one keep their path
 * through "We could not read that website".
 */
export function websiteScanResponse(
  mock: { companyWebsiteScan?: MockCompanyWebsiteScan } | undefined,
  command: string,
): MockCompanyWebsiteScan {
  const scan = mock?.companyWebsiteScan;
  if (!scan) throw new Error(`Unsupported mocked Tauri command: ${command}`);
  return scan;
}
