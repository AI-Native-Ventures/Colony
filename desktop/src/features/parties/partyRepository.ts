import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { newestHead } from "@/features/company/contracts";
import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_PARTY, KIND_PARTY_RELATIONSHIP } from "@/shared/constants/kinds";

import type {
  Party,
  PartyAlias,
  PartyHead,
  PartyParseResult,
  PartyRelationship,
  RelationshipKind,
} from "./contracts";
import {
  parsePartyHead,
  parsePartyRelationshipHead,
  partyFailure,
  RELATIONSHIP_KINDS,
  relationshipCoordinate,
} from "./contracts";

/**
 * Reading a community's party records.
 *
 * Every query names its kinds and pins `authors` to the tenant relay signer,
 * because a head is only canonical if that key wrote it. Nothing is cached to
 * disk: these are a company's customers and prospects, and their names
 * outliving a community switch is a leak, not a performance win.
 *
 * The one thing this does that the company repository does not is resolve
 * handles. A merge retires a handle and leaves a pointer at it, and a reference
 * written into a task or an agent's work context months ago still has to arrive
 * at whichever party absorbed it.
 */

const MAX_RECORDS = 500;

/**
 * The furthest a handle may be chased before the chain is called broken.
 *
 * Mirrors `buzz_core::party::MAX_ALIAS_HOPS`. Validation refuses cycles, but a
 * reader that meets one anyway has to stop rather than loop.
 */
export const MAX_ALIAS_HOPS = 8;

/**
 * Bumped by `resetPartyRepositoryState()`. A read that started before a
 * community switch resolves after it, and must not deliver the old community's
 * records into the new one.
 */
let repositoryGeneration = 0;

export type PartyRepositoryDependencies = {
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
  relaySelf: () => Promise<string | null>;
};

/** What a handle turned out to name. */
export type ResolvedHandle = {
  /** The live handle the requested one resolves to. */
  handle: string;
  /** How many merges were followed to get there. Zero means it was live. */
  mergesFollowed: number;
};

/** A party together with the views the company holds over it. */
export type PartyWithViews = {
  requested: string;
  handle: string;
  mergesFollowed: number;
  party: Party;
  relationships: PartyRelationship[];
};

function unavailable<T>(error: unknown): PartyParseResult<T> {
  return partyFailure<T>(
    "unavailable",
    `Party records could not be read: ${String(error)}`,
  );
}

export function createPartyRepository(
  dependencies: PartyRepositoryDependencies,
) {
  /**
   * One read: resolve the relay identity, query, and refuse to deliver a
   * result across a community switch.
   */
  async function read<T>(
    build: (relaySelfPubkey: string) => RelaySubscriptionFilter,
    collect: (
      events: RelayEvent[],
      relaySelfPubkey: string,
    ) => PartyParseResult<T>,
  ): Promise<PartyParseResult<T>> {
    const generation = repositoryGeneration;
    let relaySelfPubkey: string | null;
    try {
      relaySelfPubkey = await dependencies.relaySelf();
    } catch (error) {
      return unavailable<T>(error);
    }
    if (!relaySelfPubkey) {
      return partyFailure<T>(
        "no-relay-identity",
        "This community's relay has no stable identity, so it has no party records.",
      );
    }
    let events: RelayEvent[];
    try {
      events = await dependencies.fetchEvents(build(relaySelfPubkey));
    } catch (error) {
      return unavailable<T>(error);
    }
    if (generation !== repositoryGeneration) {
      return partyFailure<T>(
        "cancelled",
        "The party read was cancelled because the active community changed.",
      );
    }
    return collect(events, relaySelfPubkey);
  }

  /** Newest head per `d` coordinate, dropping anything that will not parse. */
  function collectHeads<T>(
    events: RelayEvent[],
    relaySelfPubkey: string,
    parse: (event: RelayEvent, relaySelfPubkey: string) => PartyParseResult<T>,
  ): T[] {
    const byCoordinate = new Map<string, RelayEvent>();
    for (const event of events) {
      const dTag = event.tags.find((tag) => tag[0] === "d" && tag.length === 2);
      const coordinate = dTag?.[1];
      if (coordinate === undefined) continue;
      const current = byCoordinate.get(coordinate);
      const winner = newestHead(current ? [current, event] : [event]);
      if (winner) byCoordinate.set(coordinate, winner);
    }
    const records: T[] = [];
    for (const event of byCoordinate.values()) {
      const parsed = parse(event, relaySelfPubkey);
      // A forged or malformed head sitting beside real ones is dropped rather
      // than failing the whole read; it must not appear either way.
      if (parsed.ok) records.push(parsed.value);
    }
    return records;
  }

  /**
   * Every handle in a company, live or retired.
   *
   * This is the listing read. Resolution does not use it: following a handle
   * reads one coordinate per hop instead, so answering "where does this point
   * now" costs bounded work rather than the whole party set.
   */
  async function loadOccupants(): Promise<
    PartyParseResult<{
      parties: Map<string, Party>;
      aliases: Map<string, PartyAlias>;
    }>
  > {
    return read(
      (relaySelfPubkey) => ({
        kinds: [KIND_PARTY],
        authors: [relaySelfPubkey],
        limit: MAX_RECORDS,
      }),
      (events, relaySelfPubkey) => {
        const parties = new Map<string, Party>();
        const aliases = new Map<string, PartyAlias>();
        for (const head of collectHeads(
          events,
          relaySelfPubkey,
          parsePartyHead,
        )) {
          // The relay answers for one community, so everything it returns
          // is already this community's.
          if (head.type === "party") {
            parties.set(head.party.id, head.party);
          } else if (head.type === "alias") {
            aliases.set(head.alias.id, head.alias);
          }
        }
        return { ok: true, value: { parties, aliases } };
      },
    );
  }

  /**
   * What sits at one party coordinate right now.
   *
   * `null` means nothing readable is there, which the walk reads as an unknown
   * or dangling handle. A head the strict parser rejects is reported the same
   * way rather than guessed at: no client can read it either.
   */
  async function occupantAt(
    handle: string,
  ): Promise<PartyParseResult<PartyHead | null>> {
    return read<PartyHead | null>(
      (relaySelfPubkey) => ({
        kinds: [KIND_PARTY],
        authors: [relaySelfPubkey],
        "#d": [handle],
        limit: 4,
      }),
      (events, relaySelfPubkey) => ({
        ok: true,
        value: collectHeads(events, relaySelfPubkey, parsePartyHead)[0] ?? null,
      }),
    );
  }

  return {
    /**
     * The live parties a company holds, and separately the handles its merges
     * retired.
     *
     * Retired handles are kept apart rather than folded in. They are not
     * parties, and a caller that treated one as a party would write new
     * evidence to a coordinate that now only redirects.
     */
    async listParties(): Promise<
      PartyParseResult<{ parties: Party[]; retiredHandles: PartyAlias[] }>
    > {
      const occupants = await loadOccupants();
      if (!occupants.ok) return occupants;
      return {
        ok: true,
        value: {
          parties: [...occupants.value.parties.values()].sort((left, right) =>
            left.id.localeCompare(right.id),
          ),
          retiredHandles: [...occupants.value.aliases.values()].sort(
            (left, right) => left.id.localeCompare(right.id),
          ),
        },
      };
    },

    /**
     * Follow a handle to the party it currently names.
     *
     * One read per hop, bounded by `MAX_ALIAS_HOPS`, so this costs at most nine
     * reads and in practice one or two however many parties a company holds.
     *
     * Two independent stops. The cap bounds a long chain, and a revisit check
     * ends a cycle where it closes. Validation refuses cycles, but a reader
     * that meets one anyway must survive it.
     */
    async resolveHandle(
      start: string,
    ): Promise<PartyParseResult<ResolvedHandle>> {
      let handle = start;
      const seen = new Set<string>([start]);
      for (let hops = 0; hops <= MAX_ALIAS_HOPS; hops += 1) {
        const found = await occupantAt(handle);
        if (!found.ok) return found;
        const head = found.value;
        if (head === null) {
          return partyFailure<ResolvedHandle>(
            "missing-head",
            `No party or retired handle named ${handle} exists on this community.`,
          );
        }
        if (head.type === "party") {
          return { ok: true, value: { handle, mergesFollowed: hops } };
        }
        if (seen.has(head.alias.resolvesTo)) {
          return partyFailure<ResolvedHandle>(
            "invalid-record",
            `The handle ${start} loops back on itself at ${head.alias.resolvesTo}.`,
          );
        }
        seen.add(head.alias.resolvesTo);
        handle = head.alias.resolvesTo;
      }
      return partyFailure<ResolvedHandle>(
        "invalid-record",
        `The handle ${start} does not resolve within ${MAX_ALIAS_HOPS} merges.`,
      );
    },

    /**
     * Read the Lead and Client views over one party.
     *
     * Enumerates the closed set of views against derived coordinates, which is
     * exactly what a merge does, so a view either answers at its coordinate or
     * does not exist.
     */
    async listRelationships(
      partyId: string,
    ): Promise<PartyParseResult<PartyRelationship[]>> {
      const coordinates = RELATIONSHIP_KINDS.map((kind) =>
        relationshipCoordinate(partyId, kind),
      );
      return read<PartyRelationship[]>(
        (relaySelfPubkey) => ({
          kinds: [KIND_PARTY_RELATIONSHIP],
          authors: [relaySelfPubkey],
          "#d": coordinates,
          limit: coordinates.length * 4,
        }),
        (events, relaySelfPubkey) => ({
          ok: true,
          value: collectHeads(
            events,
            relaySelfPubkey,
            parsePartyRelationshipHead,
          )
            .filter((view) => view.partyId === partyId)
            .sort((left, right) => left.id.localeCompare(right.id)),
        }),
      );
    },

    /**
     * One party with its views, following any merges that retired the handle.
     *
     * Reports the handle actually read and how many merges it took, so a caller
     * that arrived through a redirect can record the survivor rather than
     * writing again to a coordinate that only forwards.
     */
    async getPartyWithViews(
      requested: string,
    ): Promise<PartyParseResult<PartyWithViews>> {
      const resolved = await this.resolveHandle(requested);
      if (!resolved.ok) return resolved;
      // One read for the resolved coordinate, not the party set.
      const found = await occupantAt(resolved.value.handle);
      if (!found.ok) return found;
      // Resolution already followed every alias, so landing on one here means
      // the head changed underneath the read.
      const party = found.value?.type === "party" ? found.value.party : null;
      if (!party) {
        return partyFailure<PartyWithViews>(
          "missing-head",
          `That handle was retired while being read.`,
        );
      }
      const relationships = await this.listRelationships(party.id);
      if (!relationships.ok) return relationships;
      return {
        ok: true,
        value: {
          requested,
          handle: resolved.value.handle,
          mergesFollowed: resolved.value.mergesFollowed,
          party,
          relationships: relationships.value,
        },
      };
    },

    /**
     * The view of one kind a party carries, if it carries one.
     *
     * This is what "Lead and Client are views, not records" means at the read
     * boundary: the caller asks one identity for one view, rather than looking
     * up a separate lead record that could disagree with its client.
     */
    async getRelationship(
      partyId: string,
      kind: RelationshipKind,
    ): Promise<PartyParseResult<PartyRelationship | null>> {
      const views = await this.listRelationships(partyId);
      if (!views.ok) return views;
      return {
        ok: true,
        value: views.value.find((view) => view.relationship === kind) ?? null,
      };
    },
  };
}

export type PartyRepository = ReturnType<typeof createPartyRepository>;

export const partyRepository = createPartyRepository({
  fetchEvents: (filter) => relayClient.fetchEvents(filter),
  relaySelf: getRelaySelf,
});

/**
 * Wired into `resetCommunityState()`. There is no cache to clear; what this
 * invalidates is every read still in flight against the previous relay.
 */
export function resetPartyRepositoryState(): void {
  repositoryGeneration += 1;
}
