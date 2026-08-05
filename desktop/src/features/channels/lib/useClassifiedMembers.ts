import * as React from "react";

import {
  useManagedAgentsQuery,
  useRelayAgentsQuery,
} from "@/features/agents/hooks";
import { useIsArchivedPredicate } from "@/features/identity-archive/hooks";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import type { ChannelMember } from "@/shared/api/types";
import { normalizePubkey } from "@/shared/lib/pubkey";

import { collapseAgentMembersByRole } from "./collapseAgentMembersByRole";
import { compareMembersByRole } from "./memberUtils";

export function useClassifiedMembers(
  members: ChannelMember[],
  currentPubkey?: string,
) {
  const managedAgentsQuery = useManagedAgentsQuery();
  const relayAgentsQuery = useRelayAgentsQuery();
  const isArchived = useIsArchivedPredicate();

  const managedAgents = managedAgentsQuery.data ?? [];
  const relayAgents = relayAgentsQuery.data ?? [];

  const managedAgentPubkeys = React.useMemo(
    () => new Set(managedAgents.map((agent) => normalizePubkey(agent.pubkey))),
    [managedAgents],
  );
  const relayAgentPubkeys = React.useMemo(
    () => new Set(relayAgents.map((agent) => normalizePubkey(agent.pubkey))),
    [relayAgents],
  );

  // Roles come from published kind-0 profiles: the one source that covers
  // another member's agent as well as our own.
  const memberPubkeys = React.useMemo(
    () => members.map((member) => member.pubkey),
    [members],
  );
  const memberProfilesQuery = useUsersBatchQuery(memberPubkeys, {
    enabled: memberPubkeys.length > 0,
  });
  const roleOfMember = React.useCallback(
    (member: ChannelMember) =>
      memberProfilesQuery.data?.profiles?.[normalizePubkey(member.pubkey)]
        ?.role ?? null,
    [memberProfilesQuery.data?.profiles],
  );

  const isBot = React.useCallback(
    (member: ChannelMember) => {
      const normalized = normalizePubkey(member.pubkey);
      return (
        member.role === "bot" ||
        managedAgentPubkeys.has(normalized) ||
        relayAgentPubkeys.has(normalized)
      );
    },
    [managedAgentPubkeys, relayAgentPubkeys],
  );

  const isMyBot = React.useCallback(
    (member: ChannelMember) => {
      return managedAgentPubkeys.has(normalizePubkey(member.pubkey));
    },
    [managedAgentPubkeys],
  );

  // Archived wins over bot: a zombie agent should fold into "Archived", not
  // appear as an active "Bot". This is NIP-IA's headline use case. Peel
  // archived FIRST, then split the remainder into people/bots.
  const { people, bots, archived } = React.useMemo(() => {
    const peopleList: ChannelMember[] = [];
    const botList: ChannelMember[] = [];
    const archivedList: ChannelMember[] = [];

    for (const member of members) {
      if (isArchived(member.pubkey)) {
        archivedList.push(member);
        continue;
      }
      if (isBot(member)) {
        botList.push(member);
      } else {
        peopleList.push(member);
      }
    }

    const sort = (list: ChannelMember[]) =>
      [...list].sort((left, right) =>
        compareMembersByRole(left, right, currentPubkey),
      );

    // One workspace role reads as one colleague: instances owned by different
    // members collapse to the viewer's own (docs/design/role-agents.html).
    return {
      people: sort(peopleList),
      bots: collapseAgentMembersByRole(sort(botList), roleOfMember, isMyBot),
      archived: sort(archivedList),
    };
  }, [currentPubkey, isArchived, isBot, isMyBot, members, roleOfMember]);

  return {
    people,
    bots,
    archived,
    peopleCount: people.length,
    botCount: bots.length,
    archivedCount: archived.length,
    isBot,
    isMyBot,
    managedAgentsQuery,
    relayAgentsQuery,
  };
}
