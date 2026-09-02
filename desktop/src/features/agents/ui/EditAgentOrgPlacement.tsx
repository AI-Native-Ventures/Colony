import { useQueryClient } from "@tanstack/react-query";

import * as React from "react";

import {
  orgPlacementChanged,
  seedOrgPlacement,
} from "@/features/agents/editAgentOrgPlacement";
import { useCommunityOwnersQuery } from "@/features/agents/communityOwners";
import { publishManagedAgentRankHead } from "@/features/agents/managedAgentHeads";
import { useOrgMembers } from "@/features/agents/orgMembers";
import { publishEmployeeUpdate } from "@/features/agents/orgActions";
import { escalationTarget } from "@/features/agents/orgTree";
import { useCommunities } from "@/features/communities/useCommunities";
import type { ManagedAgent } from "@/shared/api/types";
import {
  AgentOrgPlacementSection,
  type OrgPlacementDraft,
} from "./AgentOrgPlacementSection";

/**
 * Org placement (rank + reporting line) inside the Edit agent dialog.
 *
 * The dialog's own update path cannot carry either field: rank is not part
 * of `UpdateManagedAgentInput` and never was, because it lives on the relay
 * (an employee row for a hired employee, an owner-authored kind-30177 head
 * for a personal agent). So this is a second write alongside the update,
 * published exactly the way the org chart's own role dialog publishes it.
 *
 * The write runs only when the owner actually moved something, so an edit
 * that touches nothing but the agent's name never republishes a head.
 */

const EMPTY_OWNERS: ReadonlySet<string> = new Set<string>();

export type EditAgentOrgPlacement = {
  /** The rendered block; the dialog decides where it sits. */
  block: React.ReactNode;
  /**
   * Publish the placement if it moved. Throws on failure so the caller can
   * keep the dialog open; the message is rendered inside the block, next to
   * the fields that caused it.
   */
  publish: () => Promise<void>;
};

export function useEditAgentOrgPlacement({
  agent,
  open,
}: {
  agent: ManagedAgent;
  open: boolean;
}): EditAgentOrgPlacement {
  const queryClient = useQueryClient();
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const { members } = useOrgMembers(communityId, open);
  const ownersQuery = useCommunityOwnersQuery(communityId, open);

  const seeded = React.useMemo(
    () => seedOrgPlacement(members, agent.pubkey),
    [members, agent.pubkey],
  );

  const [draft, setDraft] = React.useState<OrgPlacementDraft>({
    rank: seeded.rank,
    manager: seeded.manager,
  });
  const [error, setError] = React.useState<string | null>(null);
  // The chart loads after the dialog opens, so the seed arrives late and has
  // to overwrite the resting draft -- but never a selection the owner has
  // already made in this session of the dialog.
  const touched = React.useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional, agent.pubkey re-arms the seed when the dialog swaps agents without closing
  React.useEffect(() => {
    if (!open) return;
    touched.current = false;
    setError(null);
  }, [open, agent.pubkey]);

  React.useEffect(() => {
    if (!open || touched.current) return;
    setDraft({ rank: seeded.rank, manager: seeded.manager });
  }, [open, seeded]);

  const handleChange = React.useCallback((next: OrgPlacementDraft) => {
    touched.current = true;
    setDraft(next);
  }, []);

  const block = (
    <div className="space-y-2" data-testid="edit-agent-org-placement">
      <AgentOrgPlacementSection
        allowUnranked={false}
        disabled={!seeded.known}
        onChange={handleChange}
        selfPubkey={agent.pubkey}
        value={draft}
      />
      {seeded.known ? null : (
        <p
          className="text-xs text-muted-foreground"
          data-testid="edit-agent-org-placement-pending"
        >
          Placement will be available once the agent's record lands.
        </p>
      )}
      {error ? (
        <p
          className="text-sm text-destructive"
          data-testid="edit-agent-org-placement-error"
        >
          {error}
        </p>
      ) : null}
    </div>
  );

  async function publish(): Promise<void> {
    if (!seeded.known || draft.rank === "") return;
    if (!orgPlacementChanged(seeded, draft)) return;
    // An executive has no escalation target, so it carries no reporting
    // line: the same rule the role dialog applies before it publishes.
    const managerTargetRank = escalationTarget(draft.rank);
    const manager = managerTargetRank && draft.manager ? draft.manager : null;
    setError(null);
    try {
      if (seeded.isPersonalAgent) {
        await publishManagedAgentRankHead(
          {
            pubkey: agent.pubkey,
            name: agent.name,
            tier: draft.rank,
            manager,
          },
          ownersQuery.data ?? EMPTY_OWNERS,
        );
      } else {
        await publishEmployeeUpdate({
          pubkey: agent.pubkey,
          ...(draft.rank !== seeded.rank ? { rank: draft.rank } : {}),
          ...(manager ? { manager } : {}),
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["colony-employee-heads"] }),
        queryClient.invalidateQueries({
          queryKey: ["colony-managed-agent-heads"],
        }),
      ]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The agent was saved, but its placement was not published.",
      );
      throw cause;
    }
  }

  return { block, publish };
}
