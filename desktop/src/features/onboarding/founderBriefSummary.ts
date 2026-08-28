/**
 * What onboarding learned, kept just long enough for the Chief of Staff's
 * opening line to prove it was listening.
 *
 * Signup asks a founder for their city, website, what the business does and
 * what they want done first. The Welcome channel then greeted them with "Send
 * me the company website" — a question they answered two screens earlier.
 * Nothing was broken: the opener had no access to the answers, because the
 * draft is cleared the moment first run completes.
 *
 * So completion leaves a small summary behind, the kickoff opener reads it,
 * and reading clears it. Deliberately not synced, not an event, and not part
 * of the draft: it exists for one message on one machine.
 */
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from "@/shared/lib/safeStorage";

const STORAGE_KEY = "colony.onboarding.founder-brief.v1";

export type FounderBriefSummary = {
  /** "Johannesburg, South Africa", or just the city, or empty. */
  location: string;
  /** Canonical website URL, empty when the founder said there isn't one. */
  website: string;
  /** What they said the business does. */
  summary: string;
  /** The first thing they asked for. */
  firstTask: string;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function founderBriefSummaryFrom(draft: {
  founder: { city: string; country: string };
  company: { canonicalUrl: string; hasWebsite: boolean; summary: string };
  firstTask: { content: string };
}): FounderBriefSummary {
  const city = clean(draft.founder.city);
  const country = clean(draft.founder.country);
  return {
    location: [city, country].filter(Boolean).join(", "),
    website: draft.company.hasWebsite ? clean(draft.company.canonicalUrl) : "",
    summary: clean(draft.company.summary),
    firstTask: clean(draft.firstTask.content),
  };
}

/** True when the summary carries anything worth saying back to the founder. */
export function founderBriefSummaryHasContent(
  summary: FounderBriefSummary,
): boolean {
  return Boolean(
    summary.location || summary.website || summary.summary || summary.firstTask,
  );
}

export function rememberFounderBrief(summary: FounderBriefSummary): void {
  if (!founderBriefSummaryHasContent(summary)) return;
  // A greeting that cannot personalise itself is a worse greeting, not a
  // failed first run, so a storage refusal is swallowed here by design.
  setStorageItem(STORAGE_KEY, JSON.stringify(summary));
}

export function readFounderBrief(): FounderBriefSummary | null {
  const raw = getStorageItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const summary: FounderBriefSummary = {
      location: clean(record.location),
      website: clean(record.website),
      summary: clean(record.summary),
      firstTask: clean(record.firstTask),
    };
    return founderBriefSummaryHasContent(summary) ? summary : null;
  } catch {
    return null;
  }
}

export function clearFounderBrief(): void {
  removeStorageItem(STORAGE_KEY);
}

/**
 * The Chief of Staff's opening line when onboarding already answered for them.
 *
 * Reflects back what the founder said, in their own terms, then commits to the
 * task they asked for. It asks for the website only when there isn't one on
 * file, and it keeps the promise the generic opener made: nothing is created,
 * started or billed before approval.
 */
export function founderBriefOpening(summary: FounderBriefSummary): string {
  const known: string[] = [];
  if (summary.location) known.push(`based in ${summary.location}`);
  if (summary.website) known.push(summary.website);
  const knows = summary.summary
    ? `Here is what I have from your signup: ${summary.summary}${
        known.length ? ` (${known.join(", ")})` : ""
      }`
    : known.length
      ? `Here is what I have from your signup: ${known.join(", ")}`
      : "";

  const task = summary.firstTask
    ? `You asked me to start with this:\n\n> ${summary.firstTask}\n\nI am on it.`
    : "";

  // Only ask for what is genuinely missing. Asking for a website the founder
  // already gave is the exact failure this file exists to prevent.
  const ask = summary.website
    ? "I will read your site first and come back with what I found."
    : "There is no website on file, so I will ask a few focused questions instead.";

  return [knows, task, ask].filter(Boolean).join("\n\n");
}
