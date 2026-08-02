import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { newestHead } from "@/features/company/contracts";
import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_PARTY, KIND_PARTY_RELATIONSHIP } from "@/shared/constants/kinds";

import type {
  Party,
  PartyAlias,
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
   * Resolution follows a chain of unknown length, so the occupants are read in
   * one query and walked in memory rather than issuing a query per hop. Party
   * volume is an open question; if it outgrows one read the answer is a
   * relay-side resolution endpoint, not a per-hop round trip.
   */
  async function loadOccupants(companyId: string): Promise<
    PartyParseResult<{
      parties: Map<string, Party>;
      aliases: Map<string, PartyAlias>;
    }>
  > {
    return read(
      (relaySelfPubkey) => ({
        kinds: [KIND_PARTY],
        authors: [relaySelfPubkey],
        "#c": [companyId],
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
          // Scoped twice: `#c` is the indexed tag the relay can answer, and
          // this narrows again. Showing an owner another company's customers is
          // worse than being slow.
          if (head.type === "party" && head.party.companyId === companyId) {
            parties.set(head.party.id, head.party);
          } else if (
            head.type === "alias" &&
            head.alias.companyId === companyId
          ) {
            aliases.set(head.alias.id, head.alias);
          }
        }
        return { ok: true, value: { parties, aliases } };
      },
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
    async listParties(
      companyId: string,
    ): Promise<
      PartyParseResult<{ parties: Party[]; retiredHandles: PartyAlias[] }>
    > {
      const occupants = await loadOccupants(companyId);
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
     * Two independent stops. A hard cap bounds a long chain, and a revisit
     * check ends a cycle where it closes. Validation refuses cycles, but a
     * reader that meets one anyway must survive it.
     */
    async resolveHandle(
      companyId: string,
      start: string,
    ): Promise<PartyParseResult<ResolvedHandle>> {
      const occupants = await loadOccupants(companyId);
      if (!occupants.ok) return occupants;
      const { parties, aliases } = occupants.value;

      let handle = start;
      const seen = new Set<string>([start]);
      for (let hops = 0; hops <= MAX_ALIAS_HOPS; hops += 1) {
        if (parties.has(handle)) {
          return { ok: true, value: { handle, mergesFollowed: hops } };
        }
        const alias = aliases.get(handle);
        if (!alias) {
          return partyFailure<ResolvedHandle>(
            "missing-head",
            `No party or retired handle named ${handle} exists on this community.`,
          );
        }
        if (seen.has(alias.resolvesTo)) {
          return partyFailure<ResolvedHandle>(
            "invalid-record",
            `The handle ${start} loops back on itself at ${alias.resolvesTo}.`,
          );
        }
        seen.add(alias.resolvesTo);
        handle = alias.resolvesTo;
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
      companyId: string,
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
            .filter(
              (view) =>
                view.companyId === companyId && view.partyId === partyId,
            )
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
      companyId: string,
      requested: string,
    ): Promise<PartyParseResult<PartyWithViews>> {
      const resolved = await this.resolveHandle(companyId, requested);
      if (!resolved.ok) return resolved;
      const occupants = await loadOccupants(companyId);
      if (!occupants.ok) return occupants;
      const party = occupants.value.parties.get(resolved.value.handle);
      if (!party) {
        return partyFailure<PartyWithViews>(
          "missing-head",
          `That handle was retired while being read.`,
        );
      }
      const relationships = await this.listRelationships(companyId, party.id);
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
      companyId: string,
      partyId: string,
      kind: RelationshipKind,
    ): Promise<PartyParseResult<PartyRelationship | null>> {
      const views = await this.listRelationships(companyId, partyId);
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
