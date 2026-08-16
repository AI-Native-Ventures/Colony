import * as React from "react";
import { Users } from "lucide-react";

import { useAssignManagedAgentsToCommunityMutation } from "@/features/agents/hooks";
import { selectUnassignedAgents } from "@/features/agents/lib/unassignedAgents";
import {
  loadActiveCommunityId,
  loadCommunities,
} from "@/features/communities/communityStorage";
import { Button } from "@/shared/ui/button";
import { useFeedbackToasts } from "@/shared/hooks/useToastEffect";
import type { ManagedAgent } from "@/shared/api/types";

type UnassignedAgentsBannerProps = {
  agents: ManagedAgent[];
};

/**
 * Offers to pin the agents that predate the community boundary.
 *
 * These records carry a blank community pin, which the boundary reads as
 * "belongs to whoever is asking". That is why one of them shows up in every
 * community's roster and why deleting it in one community removes it from all
 * of them: it was always one record. Assigning converts it into an agent of
 * exactly one community.
 *
 * Deliberately not automatic. The records genuinely ran in several communities
 * on real installs, so nothing on disk says where they belong and the app must
 * not guess on the user's behalf.
 */
export function UnassignedAgentsBanner(props: UnassignedAgentsBannerProps) {
  const { agents } = props;
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = React.useState<string | null>(null);
  const assignMutation = useAssignManagedAgentsToCommunityMutation();

  useFeedbackToasts(noticeMessage, errorMessage);

  const unassigned = selectUnassignedAgents(agents);
  const activeCommunity = React.useMemo(() => {
    const activeId = loadActiveCommunityId();
    if (!activeId) return null;
    return (
      loadCommunities().find((community) => community.id === activeId) ?? null
    );
  }, []);

  if (unassigned.length === 0 || activeCommunity === null) {
    return null;
  }

  const agentWord = unassigned.length === 1 ? "agent" : "agents";

  async function handleAssign() {
    setErrorMessage(null);
    setNoticeMessage(null);
    try {
      const assigned = await assignMutation.mutateAsync(
        unassigned.map((agent) => agent.pubkey),
      );
      setNoticeMessage(
        `${assigned.length} ${assigned.length === 1 ? "agent" : "agents"} now belong to ${activeCommunity?.name ?? "this community"}. Start them again here.`,
      );
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not assign agents.",
      );
    }
  }

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid="unassigned-agents-banner"
    >
      <div className="flex items-start gap-3">
        <Users className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {unassigned.length} {agentWord}{" "}
            {unassigned.length === 1 ? "is" : "are"} shared with every community
          </p>
          <p className="text-sm text-muted-foreground">
            They were created before communities had their own staff, so each is
            one record shown in every roster. Deleting one here deletes it
            everywhere. Assigning them to {activeCommunity.name} stops that.
          </p>
        </div>
      </div>
      <Button
        className="shrink-0"
        data-testid="assign-unassigned-agents"
        disabled={assignMutation.isPending}
        onClick={() => {
          void handleAssign();
        }}
        size="sm"
        variant="outline"
      >
        {assignMutation.isPending
          ? "Assigning…"
          : `Assign to ${activeCommunity.name}`}
      </Button>
    </div>
  );
}
