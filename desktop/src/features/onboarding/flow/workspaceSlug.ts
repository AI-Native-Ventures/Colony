// desktop/src/features/onboarding/flow/workspaceSlug.ts

/** Longest hostname label the relay accepts (VALID_HOSTED_COMMUNITY_NAME). */
const MAX_SLUG_LENGTH = 63;

/**
 * Derive the hosted-community name from the typed company name. The user
 * never sees this value: the flow claims an address silently and the pretty
 * name stays the local community label. NFKD first so accented letters keep
 * their base letter instead of vanishing into a hyphen.
 */
export function slugifyCompany(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/, "");
  return slug === "" ? "workspace" : slug;
}

/** The base plus eight numbered fallbacks, for silent collision handling. */
export function slugCandidates(base: string): string[] {
  const candidates = [base];
  for (let n = 2; n <= 9; n += 1) {
    const suffix = `-${n}`;
    candidates.push(base.slice(0, MAX_SLUG_LENGTH - suffix.length) + suffix);
  }
  return candidates;
}
