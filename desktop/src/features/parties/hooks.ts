import { useQuery } from "@tanstack/react-query";

import type { PartyParseResult, RelationshipKind } from "./contracts";
import { partyRepository } from "./partyRepository";

/**
 * React Query access to a community's party records.
 *
 * Every key starts with the community ID. Switching community remounts the
 * subtree but the query cache survives, so a key that omitted it would serve
 * the previous community's customers to the next one.
 */

const PARTY_ROOT = "colony-party" as const;

export function partiesQueryKey(communityId: string) {
  return [PARTY_ROOT, communityId, "parties"] as const;
}

/**
 * Keyed on the handle the caller asked for, not the one it resolved to.
 *
 * A retired handle and its survivor are different questions with the same
 * answer, and the caller's own handle is what it will ask again with.
 */
export function partyQueryKey(communityId: string, handle: string) {
  return [PARTY_ROOT, communityId, "party", handle] as const;
}

export function relationshipsQueryKey(communityId: string, partyId: string) {
  return [PARTY_ROOT, communityId, "relationships", partyId] as const;
}

/**
 * A transport failure is thrown so React Query retries it; a refusal
 * ("no such party") is data and must not be retried forever.
 */
function requireAvailable<T>(result: PartyParseResult<T>): PartyParseResult<T> {
  if (!result.ok && result.code === "unavailable") {
    throw new Error(result.message);
  }
  return result;
}

export function useParties(communityId: string, enabled = true) {
  return useQuery({
    queryKey: partiesQueryKey(communityId),
    queryFn: async () => requireAvailable(await partyRepository.listParties()),
    enabled: enabled && communityId !== "",
    staleTime: 15_000,
  });
}

/**
 * One party with its Lead and Client views, following any merges that retired
 * the handle asked for.
 */
export function useParty(
  communityId: string,
  handle: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: partyQueryKey(communityId, handle ?? ""),
    queryFn: async () =>
      requireAvailable(
        await partyRepository.getPartyWithViews(handle as string),
      ),
    enabled: enabled && communityId !== "" && !!handle,
    staleTime: 15_000,
  });
}

export function usePartyRelationships(
  communityId: string,
  partyId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: relationshipsQueryKey(communityId, partyId ?? ""),
    queryFn: async () =>
      requireAvailable(
        await partyRepository.listRelationships(partyId as string),
      ),
    enabled: enabled && communityId !== "" && !!partyId,
    staleTime: 15_000,
  });
}

/**
 * The view of one kind a party carries, if it carries one.
 *
 * Derived from the same cached read as `usePartyRelationships`, so asking for
 * the Lead and the Client separately does not issue two queries and cannot show
 * two answers taken at different moments.
 */
export function usePartyRelationship(
  communityId: string,
  partyId: string | null,
  kind: RelationshipKind,
  enabled = true,
) {
  const views = usePartyRelationships(communityId, partyId, enabled);
  const result = views.data;
  const relationship =
    result?.ok === true
      ? (result.value.find((view) => view.relationship === kind) ?? null)
      : null;
  return { ...views, relationship };
}
