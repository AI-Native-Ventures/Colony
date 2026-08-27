import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import {
  askStatesFromEvents,
  type AskState,
} from "@/features/asks/lib/askState";
import { useCommunities } from "@/features/communities/useCommunities";
import { useRelaySelfQuery } from "@/features/moderation/hooks";
import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import { useRelayConnection } from "@/shared/api/useRelayConnection";
import { useStableMap } from "@/shared/hooks/useStableReference";
import { KIND_ASK_STATE } from "@/shared/constants/kinds";

const ASK_STATE_QUERY_LIMIT = 500;
const EMPTY_STATES: ReadonlyMap<string, AskState> = new Map();

/** Query key for the relay-signed ask-state heads of a set of asks. */
export function askStatesQueryKey(
  communityId: string,
  askIds: readonly string[],
) {
  return ["ask-states", communityId, askIds] as const;
}

/**
 * Read the relay-signed deadline head for each of `askIds`.
 *
 * `askIds` must be referentially stable across renders (memoize it), because
 * it is part of the query key. The returned Map is content-stabilised through
 * `useStableMap`, so a poll that re-materialises identical heads does not
 * hand a fresh Map to every consumer and defeat their memo boundaries.
 *
 * Kind 30200 is relay-only at ingest, so a stored head is by construction the
 * relay's own. The signer is checked here anyway, against the relay's NIP-11
 * `self` pubkey: the check costs one already-cached query, and a head from
 * any other pubkey is a forgery claiming a deadline the relay never set. It
 * follows that a relay advertising no `self` pubkey yields no countdowns at
 * all, which is the honest outcome rather than a silently trusted one.
 */
export function useAskStates(askIds: readonly string[]): {
  states: ReadonlyMap<string, AskState>;
  error: Error | null;
  isLoading: boolean;
} {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const connected = useRelayConnection() === "connected";
  const relaySelf = useRelaySelfQuery();

  const query = useQuery<RelayEvent[]>({
    enabled: communityId !== "" && askIds.length > 0,
    queryKey: askStatesQueryKey(communityId, askIds),
    queryFn: () =>
      relayClient.fetchEvents({
        kinds: [KIND_ASK_STATE],
        "#d": [...askIds],
        limit: ASK_STATE_QUERY_LIMIT,
      }),
    staleTime: 15_000,
    gcTime: 5 * 60 * 1_000,
    // Same connection-aware cadence as `useOpenAsks`: a re-armed or closed
    // head must land promptly, and polling a dead relay only burns the quota
    // the recovery path needs.
    refetchInterval: connected ? 30_000 : false,
  });

  const relaySelfPubkey = relaySelf.data;
  const derived = React.useMemo(
    () => askStatesFromEvents(query.data ?? [], relaySelfPubkey),
    [query.data, relaySelfPubkey],
  );
  const states = useStableMap(derived);

  return {
    states: askIds.length === 0 ? EMPTY_STATES : states,
    error:
      query.error instanceof Error
        ? query.error
        : relaySelf.error instanceof Error
          ? relaySelf.error
          : null,
    // The heads are unreadable until the relay's own pubkey is known, so a
    // pending self read is still "loading the deadline" as far as the card is
    // concerned. Reporting it as settled would flash an empty note first.
    isLoading: query.isLoading || relaySelf.isLoading,
  };
}

/** The deadline head for a single ask. Convenience over {@link useAskStates}. */
export function useAskState(askId: string | null): {
  state: AskState | null;
  error: Error | null;
  isLoading: boolean;
} {
  const askIds = React.useMemo(() => (askId ? [askId] : []), [askId]);
  const { states, error, isLoading } = useAskStates(askIds);
  return {
    state: askId ? (states.get(askId) ?? null) : null,
    error,
    isLoading,
  };
}
