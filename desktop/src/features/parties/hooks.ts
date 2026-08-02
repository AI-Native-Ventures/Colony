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

export function partiesQueryKey(communityId: string, companyId: string) {
  return [PARTY_ROOT, communityId, "parties", companyId] as const;
}

/**
 * Keyed on the handle the caller asked for, not the one it resolved to.
 *
 * A retired handle and its survivor are different questions with the same
 * answer, and the caller's own handle is what it will ask again with.
 */
export function partyQueryKey(
  communityId: string,
  companyId: string,
  handle: string,
) {
  return [PARTY_ROOT, communityId, "party", companyId, handle] as const;
}

export function relationshipsQueryKey(
  communityId: string,
  companyId: string,
  partyId: string,
) {
  return [
    PARTY_ROOT,
    communityId,
    "relationships",
    companyId,
    partyId,
  ] as const;
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

export function useParties(
  communityId: string,
  companyId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: partiesQueryKey(communityId, companyId ?? ""),
    queryFn: async () =>
      requireAvailable(await partyRepository.listParties(companyId as string)),
    enabled: enabled && communityId !== "" && !!companyId,
    staleTime: 15_000,
  });
}

/**
 * One party with its Lead and Client views, following any merges that retired
 * the handle asked for.
 */
export function useParty(
  communityId: string,
  companyId: string | null,
  handle: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: partyQueryKey(communityId, companyId ?? "", handle ?? ""),
    queryFn: async () =>
      requireAvailable(
        await partyRepository.getPartyWithViews(
          companyId as string,
          handle as string,
        ),
      ),
    enabled: enabled && communityId !== "" && !!companyId && !!handle,
    staleTime: 15_000,
  });
}

export function usePartyRelationships(
  communityId: string,
  companyId: string | null,
  partyId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: relationshipsQueryKey(
      communityId,
      companyId ?? "",
      partyId ?? "",
    ),
    queryFn: async () =>
      requireAvailable(
        await partyRepository.listRelationships(
          companyId as string,
          partyId as string,
        ),
      ),
    enabled: enabled && communityId !== "" && !!companyId && !!partyId,
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
  companyId: string | null,
  partyId: string | null,
  kind: RelationshipKind,
  enabled = true,
) {
  const views = usePartyRelationships(communityId, companyId, partyId, enabled);
  const result = views.data;
  const relationship =
    result?.ok === true
      ? (result.value.find((view) => view.relationship === kind) ?? null)
      : null;
  return { ...views, relationship };
}
