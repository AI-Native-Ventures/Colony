import * as React from "react";

import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { overlayAgentNamesOntoProfiles } from "@/features/agents/lib/agentProfileOverlay";
import {
  profileLookupsEqual,
  type UserProfileLookup,
} from "@/features/profile/lib/identity";

/**
 * A `users-batch` profile lookup overlaid with managed/relay agent registry
 * names, for surfaces that resolve DM labels and avatars outside the message
 * timeline (channel header, sidebar, drafts, reminders).
 *
 * These surfaces used to consume the batch query alone, which only knows
 * relay kind:0 events. An agent running on a relay whose kind:0 publish
 * lagged or failed then rendered as its raw pubkey in the header and sidebar
 * while the timeline intro, which merges the registries, showed the name
 * directly underneath. The overlay closes that split.
 *
 * The returned reference is stabilised across renders the same way
 * `useMessageProfiles` does: the overlay mints a fresh object whenever a
 * source query re-keys, and downstream memos treat identity as a change
 * signal, so value-identical results return the previous reference.
 */
export function useAgentNameProfiles(
  profiles: UserProfileLookup | undefined,
  currentPubkey?: string,
): UserProfileLookup | undefined {
  const managedAgents = useManagedAgentsQuery().data;
  const relayAgents = useRelayAgentsQuery().data;

  const raw = React.useMemo(
    () =>
      overlayAgentNamesOntoProfiles(
        profiles,
        managedAgents,
        relayAgents,
        currentPubkey,
      ),
    [currentPubkey, managedAgents, profiles, relayAgents],
  );

  const ref = React.useRef(raw);
  if (
    ref.current !== raw &&
    (ref.current === undefined ||
      raw === undefined ||
      !profileLookupsEqual(ref.current, raw))
  ) {
    ref.current = raw;
  }
  return ref.current;
}
