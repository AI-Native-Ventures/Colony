/**
 * Agent identity directory for website job surfaces.
 *
 * Names come from the community profile lookup (falling back to the installed
 * team's managed-agent name). Job titles prefer the community-scoped role
 * context (`useAgentRoleTitles`: locally managed agents joined to their persona
 * titles), which is the same source message rows use; the profile `role` field
 * is only a fallback, and the job owner always reads as "Owner". The colour
 * token is derived with the same stable pubkey hash the avatar fallback uses,
 * so the job surfaces agree with the rest of the app about which agent is
 * which colour. The manager hierarchy and locale are never inferred from
 * either source.
 */

import { normalizePubkey } from "@/shared/lib/pubkey";

import type {
  WebsiteAgentDirectory,
  WebsiteAgentIdentity,
} from "@/features/website/types";

import type { WebsiteHead } from "./websiteHeads";

const IDENTITY_COLOUR_TOKENS = [
  "violet",
  "amber",
  "teal",
  "rose",
  "blue",
  "lime",
] as const;

export function websiteAgentColourToken(pubkey: string): string {
  let hash = 0;
  for (const character of normalizePubkey(pubkey)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return IDENTITY_COLOUR_TOKENS[hash % IDENTITY_COLOUR_TOKENS.length];
}

/** Every pubkey the head record can name, for one profile batch request. */
export function collectWebsiteAgentPubkeys(head: WebsiteHead): string[] {
  const { record } = head;
  const pubkeys = new Set<string>([
    head.ownerPubkey,
    head.coordinatorPubkey,
    ...record.revisions.map((revision) => revision.builtBy),
    ...record.revisions.flatMap((revision) =>
      revision.qa ? [revision.qa.reviewer] : [],
    ),
    ...record.decisions.map((decision) => decision.actor),
    ...(record.handover ? [record.handover.acceptedBy] : []),
    ...(record.handover?.accessRequest
      ? [record.handover.accessRequest.authoredBy]
      : []),
  ]);
  return [...pubkeys];
}
export function buildWebsiteAgentDirectory(input: {
  profiles: Readonly<Record<string, WebsiteAgentSummary>> | undefined;
  head: WebsiteHead;
  /** Community-scoped role context (`useAgentRoleTitles`). */
  roleTitles?: ReadonlyMap<string, string> | null;
  /** Display-only team fallback pubkeys (see `useWebsiteStageTeam`). */
  extraPubkeys?: readonly string[];
  /** Names for fallback members that have no kind-0 profile yet. */
  namesByPubkey?: ReadonlyMap<string, string> | null;
}): WebsiteAgentDirectory {
  const { profiles, head, roleTitles, extraPubkeys, namesByPubkey } = input;
  const ownerPubkey = normalizePubkey(head.ownerPubkey);
  const directory = new Map<string, WebsiteAgentIdentity>();
  const pubkeys = new Set([
    ...collectWebsiteAgentPubkeys(head),
    ...(extraPubkeys ?? []),
  ]);
  for (const pubkey of pubkeys) {
    const normalized = normalizePubkey(pubkey);
    const profile = profiles?.[pubkey] ?? profiles?.[normalized];
    const name =
      profile?.displayName?.trim() ||
      profile?.name?.trim() ||
      namesByPubkey?.get(normalized)?.trim() ||
      undefined;
    if (!name) continue;
    const isOwner = normalized === ownerPubkey;
    const roleTitle = roleTitles?.get(normalized) ?? roleTitles?.get(pubkey);
    directory.set(pubkey, {
      pubkey,
      name,
      role: isOwner
        ? "Owner"
        : roleTitle?.trim() || profile?.role?.trim() || "Role not recorded",
      color: websiteAgentColourToken(pubkey),
    });
  }
  return directory;
}
/** Minimal profile fields this directory reads; matches the users-batch shape. */
export type WebsiteAgentSummary = {
  displayName?: string | null;
  name?: string | null;
  role?: string | null;
};
