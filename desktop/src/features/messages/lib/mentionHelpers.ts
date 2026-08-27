import type { AgentPersona, UserSearchResult } from "@/shared/api/types";

import { hasMention } from "./hasMention";

export type PersonaMentionTarget = {
  displayName: string;
  persona: AgentPersona;
};

export function formatSearchUserDisplayName(user: UserSearchResult) {
  return user.displayName?.trim() || user.nip05Handle?.trim() || null;
}

export function formatSearchUserSecondaryLabel(user: UserSearchResult) {
  const displayName = user.displayName?.trim();
  const nip05Handle = user.nip05Handle?.trim();
  return displayName && nip05Handle ? nip05Handle : null;
}

export function appendUniqueMentionName(
  current: string[],
  name: string,
): string[] {
  return current.some(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  )
    ? current
    : [...current, name];
}

export function extractPersonaMentionTargets(
  text: string,
  personaMentions: ReadonlyMap<string, string>,
  activePersonaById: ReadonlyMap<string, AgentPersona>,
): PersonaMentionTarget[] {
  const targets: PersonaMentionTarget[] = [];
  const seen = new Set<string>();
  for (const [displayName, personaId] of personaMentions) {
    if (seen.has(personaId) || !hasMention(text, displayName)) continue;
    const persona = activePersonaById.get(personaId);
    if (!persona) continue;
    targets.push({ displayName, persona });
    seen.add(personaId);
  }
  return targets;
}

/** A candidate's alias fields, as far as name collection cares. */
export type MentionAliasSource =
  | { kind: "block"; blockHandle: string; displayName: string }
  | { kind: "cohort"; displayName: string }
  | { kind: "discovery"; displayName: string }
  | {
      kind: "identity" | "persona" | "team";
      displayName: string | null;
      personaName?: string | null;
      roleId?: string | null;
      roleTitle?: string | null;
      secondaryLabel?: string | null;
    };

/** Trim and case-insensitively dedupe mention names, preserving first-seen order. */
export function dedupeMentionNames(
  names: readonly (string | null | undefined)[],
): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const trimmed = name?.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    seen.add(trimmed.toLowerCase());
    deduped.push(trimmed);
  }
  return deduped;
}

/**
 * Every alias `detectPrefixQuery` may match when deciding how far a mention
 * query extends.
 *
 * A single word opens the picker on its own, so `@cto` works with or without
 * this list. The list is load-bearing for MULTI-WORD aliases: `@chief of`
 * returns no query unless "Chief of Staff" is here, and it also drives the
 * trailing-space "mention complete" break. `roleId` is a hyphenated slug the
 * multi-word path can never match, but it is kept for symmetry with the
 * ranker, which scores against both halves of the role pair.
 */
export function collectSearchableMentionNames(
  candidates: readonly MentionAliasSource[],
): string[] {
  return dedupeMentionNames(
    candidates.flatMap((candidate) =>
      candidate.kind === "block"
        ? [candidate.displayName, candidate.blockHandle]
        : candidate.kind === "cohort"
          ? [candidate.displayName]
          : candidate.kind === "discovery"
            ? [candidate.displayName]
            : [
                candidate.displayName,
                candidate.personaName,
                candidate.roleId,
                candidate.roleTitle,
                candidate.secondaryLabel,
              ],
    ),
  );
}

/**
 * Pick the token a mention may safely occupy in the draft.
 *
 * One visible token may only ever bind to one target, because the draft's
 * mention maps are keyed by that text. Ranking already refuses a role title
 * shared by two candidates in the same result set, but it cannot see a token
 * this draft accepted from an *earlier* query — two agents can hold the same
 * role, so `@CTO` may already be spoken for. Falling back to the personal name
 * keeps the draft lossless; overwriting the binding would leave the earlier
 * `@CTO` in the text silently pointing at the wrong agent.
 *
 * Returns `null` when no token is safe — the desired token is taken and the
 * personal name is taken too (or is itself the contested token). The caller
 * must then insert the text without rebinding, so the mention already committed
 * to the draft keeps resolving. That is the known limit of a text-keyed editor:
 * it cannot represent two entities behind one visible token, so the earlier
 * binding wins rather than being silently replaced.
 *
 * The unbound token is NOT visually distinguishable: the composer highlight is
 * a global case-insensitive regex over the selected mention names, and that
 * name is already selected, so the new token chips exactly like the bound one
 * while resolving to the earlier target. Surfacing that to the user needs a
 * rich mention-node editor, not a text-keyed one.
 *
 * Matching is case-insensitive because `hasMention` is: `Cto` and `CTO` are
 * the same token as far as send-time resolution is concerned.
 */
export function resolveMentionInsertLabel(opts: {
  desiredLabel: string;
  personalName?: string | null;
  pubkey?: string;
  personaId?: string;
  mentions: ReadonlyMap<string, string>;
  personaMentions: ReadonlyMap<string, string>;
}): string | null {
  const heldByAnotherTarget = (candidateLabel: string) => {
    const wanted = candidateLabel.toLowerCase();
    for (const [label, pubkey] of opts.mentions) {
      if (label.toLowerCase() !== wanted) continue;
      return (
        opts.pubkey === undefined ||
        pubkey.toLowerCase() !== opts.pubkey.toLowerCase()
      );
    }
    for (const [label, personaId] of opts.personaMentions) {
      if (label.toLowerCase() !== wanted) continue;
      return personaId !== opts.personaId;
    }
    return false;
  };

  if (!heldByAnotherTarget(opts.desiredLabel)) {
    return opts.desiredLabel;
  }

  const fallback = opts.personalName?.trim();
  if (!fallback || fallback === opts.desiredLabel) {
    return null;
  }
  // The fallback must clear the same bar, or it would clobber whichever target
  // already answers to the personal name.
  return heldByAnotherTarget(fallback) ? null : fallback;
}
