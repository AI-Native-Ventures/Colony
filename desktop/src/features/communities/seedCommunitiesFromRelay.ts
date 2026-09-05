import { useEffect } from "react";

import type { Community } from "./types";
import { loadCommunities } from "./communityStorage";
import {
  type ColonyCommunitiesResponse,
  type HostedCommunity,
  hostedCommunityRelayUrl,
  listColonyCommunities,
} from "./hostedCommunityApi";
import { useCommunities } from "./useCommunities";

/**
 * Communities the relay says this identity belongs to, merged into the rail so
 * a community created by the founder's agent (`buzz communities create`) shows
 * up without the founder typing its host by hand.
 *
 * The merge is deliberately additive only. It never removes an entry, never
 * reorders one, and never touches the active community: a stale or partial
 * relay answer must not be able to rearrange the rail under the user.
 */

export type MergeDiscoveredOptions = {
  /** `addedAt` stamp for entries this merge appends. */
  now: string;
  /** Fallback id when the relay omits one. */
  makeId: () => string;
};

export type MergeDiscoveredResult = {
  /** The full list to persist. Identical reference to `stored` when nothing was added. */
  communities: Community[];
  /** Only the entries that were appended, in relay order. */
  added: Community[];
};

/**
 * Turn one relay entry into a `Community`, or null when it cannot be used:
 * archived communities are ignored, and so is anything without a host we can
 * derive a relay URL from.
 */
function toCommunity(
  entry: HostedCommunity,
  options: MergeDiscoveredOptions,
): Community | null {
  if (entry.archived_at) return null;
  const relayUrl = hostedCommunityRelayUrl(entry);
  if (!relayUrl) return null;
  const name = entry.slug?.trim() || entry.name?.trim();
  if (!name) return null;
  return {
    id: entry.id?.trim() || options.makeId(),
    name,
    relayUrl,
    addedAt: options.now,
  };
}

/**
 * Append relay-reported communities the stored list does not already have.
 *
 * Pure: no storage, no network, no clock. An entry already present by relay
 * URL or by id is left exactly as it is, including its name and position.
 */
export function mergeDiscoveredCommunities(
  stored: Community[],
  response: ColonyCommunitiesResponse | null | undefined,
  options: MergeDiscoveredOptions,
): MergeDiscoveredResult {
  const entries = response?.communities;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { communities: stored, added: [] };
  }

  const seenRelayUrls = new Set(stored.map((community) => community.relayUrl));
  const seenIds = new Set(stored.map((community) => community.id));
  const added: Community[] = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const community = toCommunity(entry, options);
    if (!community) continue;
    if (seenRelayUrls.has(community.relayUrl) || seenIds.has(community.id)) {
      continue;
    }
    seenRelayUrls.add(community.relayUrl);
    seenIds.add(community.id);
    added.push(community);
  }

  if (added.length === 0) {
    return { communities: stored, added: [] };
  }
  return { communities: [...stored, ...added], added };
}

/**
 * Relay URLs already seeded during this launch.
 *
 * Launch-scoped by design, so this is not wired into `resetCommunityState()`:
 * it is keyed by relay URL, so nothing leaks between communities, and a
 * community switch that lands on a relay we have not asked yet still gets its
 * one request.
 */
const seededRelayUrls = new Set<string>();

/** Test-only escape hatch for the launch-scoped seed guard. */
export function resetCommunitySeedGuard(): void {
  seededRelayUrls.clear();
}

/**
 * Ask the connected relay, once per relay per launch, which communities this
 * identity belongs to, and add the ones the rail is missing.
 *
 * Failures are silent on purpose. A relay with no self-provision domain
 * answers 404, and an offline launch fails outright; neither is a problem the
 * user can act on, so both leave the rail exactly as it was.
 */
export function useSeedCommunitiesFromRelay(
  relayUrl: string | null,
  isReady: boolean,
): void {
  const { addCommunity } = useCommunities();

  useEffect(() => {
    if (!isReady || !relayUrl) return;
    if (seededRelayUrls.has(relayUrl)) return;
    seededRelayUrls.add(relayUrl);

    let cancelled = false;
    void (async () => {
      let response: ColonyCommunitiesResponse;
      try {
        response = await listColonyCommunities("member");
      } catch (error) {
        console.debug(
          "[seedCommunitiesFromRelay] discovery unavailable:",
          error,
        );
        return;
      }
      if (cancelled) return;

      // Read the persisted list rather than the context value: it is the same
      // data, and it keeps the effect off a dependency that changes every time
      // we add an entry.
      const { added } = mergeDiscoveredCommunities(
        loadCommunities(),
        response,
        {
          now: new Date().toISOString(),
          makeId: () => crypto.randomUUID(),
        },
      );
      for (const community of added) {
        addCommunity(community);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [relayUrl, isReady, addCommunity]);
}
