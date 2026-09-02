import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_MANAGED_AGENT } from "@/shared/constants/kinds";
import {
  isValidRoleSlug,
  parseRank,
  type AgentRank,
} from "@/features/agents/employeeHeads";
import { recordOrgPlacement } from "@/shared/api/orgPlacement";
import { signRelayEvent } from "@/shared/api/tauri";
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
 * The rank a role implies when nothing else has said one.
 *
 * A Chief of Staff is an executive by definition, so a head claiming that
 * role and nothing else should not land beside an engineer in Unranked. Every
 * other role defaults to Team lead: an agent that cannot escalate to the owner
 * is worse than one that can, because a worker "may never address owners"
 * (`buzz_core::interrupt`), so an unplaced worker's escalations have nowhere
 * to go at all.
 */
function rankImpliedByRole(roleId: string | null): AgentRank {
  return roleId === "chief-of-staff" ? "executive" : "leader";
}

/**
 * Resolve an agent's rank the way the relay's `agent_tier` does for a
 * managed agent: the employee currently filling the claimed role decides
 * first; only a role nobody fills falls through to the head's own tier.
 *
 * A head that resolves neither takes the rank its role implies rather than
 * none at all. "No rank" was never a real state an owner chose: it is what a
 * head looks like when it was written without one, and it dropped the agent
 * off the org chart entirely until someone re-ranked it by hand. Since rank is
 * published at agent creation and keyed to that instance, every path that
 * produced a fresh instance sent the owner back to the Unranked list to do it
 * again.
 *
 * This never overrides a stated rank; it only replaces the empty case.
 */
export function resolveManagedAgentRank(
  head: Pick<ManagedAgentHead, "roleId" | "tierRank">,
  employeesByRole: ReadonlyMap<string, { rank: AgentRank }>,
): AgentRank {
  if (head.roleId) {
    const employee = employeesByRole.get(head.roleId);
    if (employee) return employee.rank;
  }
  return head.tierRank ?? rankImpliedByRole(head.roleId);
}

/**
 * Bumped by `resetManagedAgentHeadsState()`. A read that started before a
 * community switch resolves after it, and must not deliver the old
 * community's managed-agent heads into the new one — the same guard
 * `fetchEmployeeHeads` uses via `resetEmployeeHeadsState`.
 */
let repositoryGeneration = 0;

export function resetManagedAgentHeadsState(): void {
  repositoryGeneration += 1;
}

export async function fetchManagedAgentHeadEvents(): Promise<RelayEvent[]> {
  const generation = repositoryGeneration;
  const filter: RelaySubscriptionFilter = {
    kinds: [KIND_MANAGED_AGENT],
    limit: 500,
  };
  let events: RelayEvent[];
  try {
    events = await relayClient.fetchEvents(filter);
  } catch (error) {
    if (generation !== repositoryGeneration) return [];
    throw error;
  }
  if (generation !== repositoryGeneration) {
    // The community switched mid-read; drop everything.
    return [];
  }
  return events;
}

const MANAGED_AGENT_HEADS_ROOT = "colony-managed-agent-heads" as const;

/** Community-scoped query key for the raw kind-30177 head fetch. */
export function managedAgentHeadsQueryKey(communityId: string) {
  return [MANAGED_AGENT_HEADS_ROOT, communityId] as const;
}

/**
 * Writing rank onto a personal agent.
 *
 * A personal agent has no employee row for the relay to speak about, so its
 * rank lives on the owner-authored kind-30177 head the desktop already
 * publishes: `content.tier` for the rung (what `agent_tier` reads) and a
 * `manager` TAG for the reporting line (what `agent_manager` reads -- tags,
 * not content, because that is where reports are indexed). Republishing is
 * NIP-33 latest-wins at `(kind, author, d)`, so the replacement must merge
 * into the newest owner-authored head's content rather than replace it:
 * other readers of 30177 resolve name and definition linkage from the same
 * event, and a synthesized body would unlink them.
 */

/** Thrown when no owner-authored head has landed for the agent yet. */
export class ManagedAgentHeadNotLandedError extends Error {
  constructor(pubkey: string) {
    super(
      `No workspace-published profile has landed on the relay for ${pubkey} yet; try again in a moment.`,
    );
    this.name = "ManagedAgentHeadNotLandedError";
  }
}

/**
 * The newest owner-authored head event at `dTag`, or null. This is the event
 * a rank republish supersedes and merges into; impostor-authored candidates
 * are invisible here exactly as they are everywhere else in this module.
 */
export function newestOwnerAuthoredHeadEvent(
  events: readonly RelayEvent[],
  ownerPubkeys: ReadonlySet<string>,
  dTag: string,
): RelayEvent | null {
  let newest: RelayEvent | null = null;
  for (const event of events) {
    if (event.kind !== KIND_MANAGED_AGENT) continue;
    const d = singleTagValue(event, "d")?.trim().toLowerCase();
    if (d !== dTag) continue;
    if (!ownerPubkeys.has(normalizePubkey(event.pubkey))) continue;
    if (!newest || event.created_at > newest.created_at) newest = event;
  }
  return newest;
}

/** Live lookup of the same, for callers deciding whether a head has landed. */
export async function fetchNewestOwnerAuthoredHead(
  pubkey: string,
  ownerPubkeys: ReadonlySet<string>,
): Promise<RelayEvent | null> {
  return newestOwnerAuthoredHeadEvent(
    await fetchManagedAgentHeadEvents(),
    ownerPubkeys,
    pubkey,
  );
}

/**
 * The created_at a replacement head needs: newer than both now and the head
 * it supersedes, so an in-flight retention flush can never shadow the rank
 * with the older body it still holds. Seconds, as Nostr requires.
 */
export function supersedingCreatedAt(
  previous: RelayEvent | null,
  nowMs: number,
): number {
  const nowSeconds = Math.floor(nowMs / 1000);
  const afterPrevious = previous ? previous.created_at + 1 : 0;
  return Math.max(nowSeconds, afterPrevious);
}

/**
 * Merge `tier` into the previous head's content JSON. Fields the org chart
 * does not read -- name, definition linkage, respond-to -- survive the
 * republish untouched; malformed content degrades to a minimal body naming
 * the agent rather than failing the write.
 */
export function buildRankedHeadContent(
  previousContent: string | null,
  fallbackName: string,
  tier: AgentRank,
): string {
  let base: Record<string, unknown> = {};
  if (previousContent) {
    try {
      const parsed: unknown = JSON.parse(previousContent);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      // Content that does not parse says nothing worth preserving.
    }
  }
  if (typeof base.name !== "string" || base.name.trim().length === 0) {
    base.name = fallbackName;
  }
  base.tier = tier;
  return JSON.stringify(base);
}

/** The tag shape of a ranked head: the `d` tag plus an optional manager line. */
export function rankedHeadTags(
  dTag: string,
  manager: string | null,
): string[][] {
  const tags = [["d", dTag]];
  if (manager) tags.push(["manager", manager]);
  return tags;
}

export type ManagedAgentRankInput = {
  /** The agent being ranked; becomes the `d` tag. */
  pubkey: string;
  /** Display-name fallback for the rare case the merged content names none. */
  name: string;
  tier: AgentRank;
  /** Manager pubkey, or null to publish no manager line. */
  manager: string | null;
};

/**
 * Publish an owner-signed kind-30177 head carrying `tier` and `manager`.
 *
 * Refuses (fail closed) while the community's owner set is unknown: without
 * it the newest owner-authored head cannot be found, so the merge could not
 * preserve the fields other readers rely on. Refuses when no owner-authored
 * head has landed yet -- ranking a freshly created agent races the async
 * identity publication, and guessing the body would publish a head that
 * unlinks the agent's definition for every reader.
 *
 * The relay accepts this event from any member (kind 30177 is
 * client-writable), so trust comes from authorship, not ingest: only the
 * owner's device signs here, which is what makes the result authoritative.
 */
export async function publishManagedAgentRankHead(
  input: ManagedAgentRankInput,
  ownerPubkeys: ReadonlySet<string>,
): Promise<string> {
  if (!/^[0-9a-f]{64}$/.test(input.pubkey)) {
    throw new Error("An agent rank needs a valid pubkey.");
  }
  if (input.manager && !/^[0-9a-f]{64}$/.test(input.manager)) {
    throw new Error("A manager needs a valid pubkey.");
  }
  if (ownerPubkeys.size === 0) {
    throw new Error(
      "The workspace's owners could not be verified, so the rank was not published.",
    );
  }

  const events = await fetchManagedAgentHeadEvents();
  const previous = newestOwnerAuthoredHeadEvent(
    events,
    ownerPubkeys,
    input.pubkey,
  );
  if (!previous) {
    throw new ManagedAgentHeadNotLandedError(input.pubkey);
  }

  const event = await signRelayEvent({
    kind: KIND_MANAGED_AGENT,
    content: buildRankedHeadContent(previous.content, input.name, input.tier),
    createdAt: supersedingCreatedAt(previous, Date.now()),
    tags: rankedHeadTags(input.pubkey, input.manager),
  });
  await relayClient.publishEvent(
    event,
    "Timed out while updating the agent's rank.",
    "Failed to update the agent's rank.",
  );
  // The relay copy is authoritative for readers, but the device rebuilds the
  // head from the local record. Without this write the next rebuild drops
  // the placement and the roster falls back to team lead / unassigned.
  await recordOrgPlacement({
    pubkey: input.pubkey,
    tier: input.tier,
    manager: input.manager ?? null,
  });
  return event.id;
}
