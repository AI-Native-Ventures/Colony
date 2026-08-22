import { invoke } from "@/shared/api/nativeBridge";

export const COMPANY_SCAN_TIMEOUT_MS = 300_000;

type RawEvidence = { value: string; sourceUrl?: string; source_url?: string };
type RawPageEvidence = {
  url: string;
  title?: RawEvidence | null;
  description?: RawEvidence | null;
  headings?: string[];
  text: string;
};
type RawCompanyScan = {
  requestedUrl?: string;
  requested_url?: string;
  canonicalUrl?: string;
  canonical_url?: string;
  pages: RawPageEvidence[];
  warnings: string[];
};
type RawCompanyScanOutcome =
  | { status: "success"; result: RawCompanyScan }
  | { status: "invalid" | "failed" | "timeout"; message: string };

export type CompanyScan = {
  requestedUrl: string;
  canonicalUrl: string;
  pages: RawPageEvidence[];
  warnings: string[];
};
export type CompanyScanOutcome =
  | { status: "success"; result: CompanyScan }
  | { status: "invalid" | "failed" | "timeout"; message: string };

function trimBounded(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

export function fromRawCompanyScan(raw: RawCompanyScan): CompanyScan {
  return {
    requestedUrl: raw.requestedUrl ?? raw.requested_url ?? "",
    canonicalUrl: raw.canonicalUrl ?? raw.canonical_url ?? "",
    pages: raw.pages ?? [],
    warnings: raw.warnings ?? [],
  };
}

export function buildEditableCompanySummary(scan: CompanyScan): string {
  const lead = scan.pages[0];
  const candidates = [
    lead?.description?.value,
    lead?.text,
    ...scan.pages
      .slice(1, 4)
      .map((page) => page.description?.value ?? page.text),
  ].filter((value): value is string => Boolean(value?.trim()));
  return trimBounded(candidates.join(" "), 1_200);
}

export async function scanOnboardingCompanyWebsite(
  url: string,
): Promise<CompanyScanOutcome> {
  const outcome = await invoke<RawCompanyScanOutcome>(
    "scan_onboarding_company_website",
    { url },
  );
  return outcome.status === "success"
    ? { status: "success", result: fromRawCompanyScan(outcome.result) }
    : outcome;
}
