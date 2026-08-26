/**
 * Resolve a message's cohort-mention reference tags
 * (`["a", "30201:<relay-pubkey>:<id>", "", "cohort"]`) into the display
 * names `remarkMentions` should highlight.
 *
 * The tag carries no display name — a cohort's `d` tag is an opaque id, not
 * a slug like a Block handle — so this reads it back through the current
 * `cohortNameByAddress` catalog snapshot rather than the tag alone. A
 * renamed or deleted cohort simply stops highlighting; the message text
 * itself is untouched.
 */
export function resolveCohortMentionNames(
  tags: string[][] | undefined,
  cohortNameByAddress: Record<string, string>,
): string[] {
  if (!tags) return [];
  const names = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== "a" || tag[3] !== "cohort" || !tag[1]) continue;
    const name = cohortNameByAddress[tag[1].toLowerCase()];
    if (name) names.add(name);
  }
  return [...names];
}
