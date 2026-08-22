import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_MANAGED_AGENT } from "@/shared/constants/kinds";
import {
  isValidRoleSlug,
  parseRank,
  type AgentRank,
} from "@/features/agents/employeeHeads";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Reading rank and reporting lines off managed-agent heads (kind 30177).
 *
 * Kind 30177 is client-writable: any authenticated member can publish a head
 * at any `d` tag. The relay therefore treats a head as authoritative ONLY
 * when its author currently holds the community's `owner` role, scanning
 * candidates newest-first and stopping at the first owner-authored one --
 * even if that head turns out to be malformed -- rather than falling through
 * to an older head the owner already superseded. See
 * `crates/buzz-relay/src/interrupt_gate.rs` (`agent_tier`, `agent_manager`):
 * this module mirrors that scan step for step, because a chart that trusted
 * the newest head would draw the reporting lines of an impostor.
 */

/** One managed-agent head, parsed defensively. */
export type ManagedAgentHead = {
  /** The agent pubkey (lowercase hex), from the `d` tag. */
  pubkey: string;
  /** The agent's display name (`content.name`), or null when absent. */
  name: string | null;
  /** The role this head claims (`content.role_id`), normalized; null when absent or not a valid slug. */
  roleId: string | null;
  /** The rank claimed directly in `content.tier`; null when absent or unknown. */
  tierRank: AgentRank | null;
  /** The manager tag (lowercase hex), or null when absent, duplicated, or malformed. */
  manager: string | null;
};

function singleTagValue(event: RelayEvent, name: string): string | null {
  const matches = event.tags.filter((tag) => tag[0] === name);
  if (matches.length !== 1) return null;
  return matches[0][1] ?? null;
}

/**
 * Parse one managed-agent head. Malformed pieces become nulls rather than
 * failing the read: a hostile or corrupt head must degrade, never throw.
 * Returns null only when the event is not a 30177 head with a usable identity.
 */
export function parseManagedAgentHead(
  event: RelayEvent,
): ManagedAgentHead | null {
  if (event.kind !== KIND_MANAGED_AGENT) return null;
  const pubkey = singleTagValue(event, "d")?.trim().toLowerCase();
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) return null;

  let name: string | null = null;
  let roleId: string | null = null;
  let tierRank: AgentRank | null = null;
  try {
    const content = JSON.parse(event.content) as Record<string, unknown>;
    if (typeof content.name === "string" && content.name.trim().length > 0) {
      name = content.name.trim();
    }
    if (typeof content.role_id === "string") {
      const normalized = content.role_id.trim().toLowerCase();
      roleId = isValidRoleSlug(normalized) ? normalized : null;
    }
    if (typeof content.tier === "string") {
      tierRank = parseRank(content.tier.trim().toLowerCase());
    }
  } catch {
    // Content that does not parse says nothing about role or tier; the
    // manager tag below is still readable.
  }

  // Same convention as the employee-head read: duplicate or non-hex manager
  // tags resolve to NO manager, mirroring the relay's fail-closed
  // `event_single_tag`.
  const rawManager = singleTagValue(event, "manager")?.trim().toLowerCase();
  const manager =
    rawManager !== undefined && /^[0-9a-f]{64}$/.test(rawManager)
      ? rawManager
      : null;

  return { pubkey, name, roleId, tierRank, manager };
}

/**
 * The trusted heads: per agent, walk EVERY candidate head newest-first and
 * take the first one authored by a CURRENT community owner, exactly as the
 * relay does before it reads anything off a head. The scan cannot shortcut
 * through the newest event per pubkey: an impostor may sit above the
 * owner's real head at the same `d` tag, and skipping the scan would trust
 * the impostor's silence over the owner's statement underneath it.
 *
 * Agents with no owner-authored candidate are omitted entirely -- a
 * self-published head names nothing.
 */
export function trustedManagedAgentHeads(
  events: RelayEvent[],
  ownerPubkeys: ReadonlySet<string>,
): ManagedAgentHead[] {
  const candidatesByPubkey = new Map<string, RelayEvent[]>();
  for (const event of events) {
    const parsed = parseManagedAgentHead(event);
    if (!parsed) continue;
    const group = candidatesByPubkey.get(parsed.pubkey);
    if (group) {
      group.push(event);
    } else {
      candidatesByPubkey.set(parsed.pubkey, [event]);
    }
  }

  const heads: ManagedAgentHead[] = [];
  for (const [, candidates] of candidatesByPubkey) {
    const trusted = [...candidates]
      .sort((a, b) => b.created_at - a.created_at)
      .find((candidate) => ownerPubkeys.has(normalizePubkey(candidate.pubkey)));
    if (!trusted) continue;
    const parsed = parseManagedAgentHead(trusted);
    if (parsed) heads.push(parsed);
  }
  return heads.sort((a, b) => a.pubkey.localeCompare(b.pubkey));
}

/**
 * Resolve an agent's rank the way the relay's `agent_tier` does for a
 * managed agent: the employee currently filling the claimed role decides
 * first; only a role nobody fills falls through to the head's own tier.
 */
export function resolveManagedAgentRank(
  head: Pick<ManagedAgentHead, "roleId" | "tierRank">,
  employeesByRole: ReadonlyMap<string, { rank: AgentRank }>,
): AgentRank | null {
  if (head.roleId) {
    const employee = employeesByRole.get(head.roleId);
    if (employee) return employee.rank;
  }
  return head.tierRank;
}

export async function fetchManagedAgentHeadEvents(): Promise<RelayEvent[]> {
  const filter: RelaySubscriptionFilter = {
    kinds: [KIND_MANAGED_AGENT],
    limit: 500,
  };
  return relayClient.fetchEvents(filter);
}

const MANAGED_AGENT_HEADS_ROOT = "colony-managed-agent-heads" as const;

/** Community-scoped query key for the raw kind-30177 head fetch. */
export function managedAgentHeadsQueryKey(communityId: string) {
  return [MANAGED_AGENT_HEADS_ROOT, communityId] as const;
}
