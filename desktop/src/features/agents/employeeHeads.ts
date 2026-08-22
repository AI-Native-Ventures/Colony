import { useQuery } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_EMPLOYEE } from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Reading a community's employee heads (kind 30190).
 *
 * An employee head is the workspace's statement of who it employs and at what
 * rank. The relay mints and holds every employee key, so the head's author IS
 * the employee, and the `d` tag carries the same pubkey (NIP-33
 * parameterized replaceable). Any head that reached the store passed the
 * ingest gate, which refuses heads whose author is not a registered
 * employee -- so what is parsed here is what the workspace actually employs.
 *
 * Ranks are read-only here; changing one is an owner-signed operation handled
 * by the relay. Nothing is cached to disk: a rank outliving a community
 * switch is a leak, not a performance win.
 */

/** Where an agent sits in the interrupt ladder. Matches the head `rank` tag. */
export type AgentRank = "worker" | "leader" | "executive";

/**
 * Plain-language labels, never the raw enum string and never the word "tier".
 * These exact strings are the product copy for each rung.
 */
export const RANK_LABELS: Record<AgentRank, string> = {
  worker: "Worker",
  leader: "Team lead",
  executive: "Chief of staff",
};

export function rankLabel(rank: AgentRank): string {
  return RANK_LABELS[rank];
}

export function parseRank(value: string | undefined): AgentRank | null {
  if (value === "worker" || value === "leader" || value === "executive") {
    return value;
  }
  return null;
}

/** One employee, projected from its newest head. */
export type EmployeeHead = {
  /** The employee pubkey (lowercase hex), from the `d` tag. */
  pubkey: string;
  role: string;
  name: string;
  rank: AgentRank;
};

function tagValue(event: RelayEvent, name: string): string | undefined {
  const tag = event.tags.find((candidate) => candidate[0] === name);
  return tag?.[1];
}

/**
 * Parse one employee head. Returns null for anything malformed rather than
 * failing the whole read; a stray event must not hide real employees.
 */
export function parseEmployeeHead(event: RelayEvent): EmployeeHead | null {
  if (event.kind !== KIND_EMPLOYEE) return null;
  const pubkey = tagValue(event, "d")?.trim().toLowerCase();
  const rank = parseRank(tagValue(event, "rank")?.trim().toLowerCase());
  // A head without both identity and rank says nothing usable.
  if (!pubkey || !rank || !/^[0-9a-f]{64}$/.test(pubkey)) return null;
  return {
    pubkey,
    role: tagValue(event, "role") ?? "",
    name: tagValue(event, "name") ?? "",
    rank,
  };
}

const MAX_HEADS = 500;

/**
 * Bumped by `resetEmployeeHeadsState()`. A read that started before a
 * community switch resolves after it, and must not deliver the old
 * community's payroll into the new one.
 */
let repositoryGeneration = 0;

export function resetEmployeeHeadsState(): void {
  repositoryGeneration += 1;
}

/**
 * Newest head per employee, parsed. Replacement should keep one head per key
 * anyway; this is defensive against a relay that does not. Malformed events
 * are dropped rather than failing the whole read.
 */
export function collectEmployeeHeads(events: RelayEvent[]): EmployeeHead[] {
  const newestByPubkey = new Map<string, RelayEvent>();
  for (const event of events) {
    const parsed = parseEmployeeHead(event);
    if (!parsed) continue;
    const current = newestByPubkey.get(parsed.pubkey);
    if (!current || event.created_at > current.created_at) {
      newestByPubkey.set(parsed.pubkey, event);
    }
  }
  const heads: EmployeeHead[] = [];
  for (const event of newestByPubkey.values()) {
    const parsed = parseEmployeeHead(event);
    if (parsed) heads.push(parsed);
  }
  return heads;
}

async function fetchEmployeeHeads(): Promise<EmployeeHead[]> {
  const generation = repositoryGeneration;
  const filter: RelaySubscriptionFilter = {
    kinds: [KIND_EMPLOYEE],
    limit: MAX_HEADS,
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
  return collectEmployeeHeads(events);
}

const EMPLOYEE_HEADS_ROOT = "colony-employee-heads" as const;

/** Community-scoped query key: the cache survives community switches. */
export function employeeHeadsQueryKey(communityId: string) {
  return [EMPLOYEE_HEADS_ROOT, communityId] as const;
}

/**
 * Every employee head in the active community, as a Map keyed by normalized
 * pubkey. The Map is built once per fetch inside the query function, so its
 * reference is stable between refetches and consumers can `.get()` per row
 * without re-render storms.
 */
export function useEmployeeHeadsQuery(communityId: string, enabled = true) {
  return useQuery({
    queryKey: employeeHeadsQueryKey(communityId),
    queryFn: fetchEmployeeHeads,
    enabled: enabled && communityId !== "",
    staleTime: 30_000,
    select: (heads) => {
      const byPubkey = new Map<string, EmployeeHead>();
      for (const head of heads) byPubkey.set(head.pubkey, head);
      return byPubkey;
    },
  });
}

/** One agent's rank, or null when it has no employee head. */
export function useAgentRank(
  communityId: string,
  pubkey: string | null | undefined,
): AgentRank | null {
  const headsQuery = useEmployeeHeadsQuery(communityId, Boolean(pubkey));
  if (!pubkey) return null;
  return headsQuery.data?.get(normalizePubkey(pubkey))?.rank ?? null;
}
