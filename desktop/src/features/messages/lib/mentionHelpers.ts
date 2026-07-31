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
