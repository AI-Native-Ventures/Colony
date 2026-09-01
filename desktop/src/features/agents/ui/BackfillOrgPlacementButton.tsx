import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  useManagedAgentsQuery,
  usePersonasQuery,
} from "@/features/agents/hooks";
import {
  backfillLabel,
  planOrgBackfill,
  type BackfillPlacement,
} from "@/features/agents/backfillOrgPlacement";
import { publishManagedAgentRankHead } from "@/features/agents/managedAgentHeads";
import { Button } from "@/shared/ui/button";

type BackfillOrgPlacementButtonProps = {
  /** Agents currently sitting in the unassigned tray. */
  unplaced: readonly { pubkey: string; name: string; rank?: string | null }[];
  ownerPubkeys: ReadonlySet<string>;
};

/**
 * One action that files every unassigned agent under the Chief of Staff.
 *
 * `resolveDefaultOrgPlacement` places agents created from now on. Agents whose
 * heads were already republished without a `manager` tag stay unassigned
 * forever otherwise, and an agent that reports to nobody belongs to no team
 * the company contract accepts, so work cannot be assigned to it at all.
 *
 * Rendered only when it would do something: no Chief of Staff deployed, or
 * nobody to place, and the button is absent rather than present and inert.
 */
export function BackfillOrgPlacementButton({
  unplaced,
  ownerPubkeys,
}: BackfillOrgPlacementButtonProps) {
  const queryClient = useQueryClient();
  const personasQuery = usePersonasQuery();
  const agentsQuery = useManagedAgentsQuery();

  const plan = React.useMemo(
    () =>
      planOrgBackfill({
        unplaced: unplaced.map((agent) => ({
          pubkey: agent.pubkey,
          name: agent.name,
          rank: (agent.rank ?? null) as BackfillPlacement["tier"] | null,
        })),
        agents: agentsQuery.data,
        personas: personasQuery.data,
      }),
    [unplaced, agentsQuery.data, personasQuery.data],
  );

  const mutation = useMutation({
    mutationFn: async (placements: BackfillPlacement[]) => {
      let placed = 0;
      const failed: string[] = [];
      // Sequential, not parallel: each publish merges into the agent's own
      // owner-authored head, and the relay is the shared resource here. One
      // failure must not abandon the rest, so every result is collected and
      // reported together.
      for (const placement of placements) {
        try {
          await publishManagedAgentRankHead(
            {
              pubkey: placement.pubkey,
              name: placement.name,
              tier: placement.tier,
              manager: placement.manager,
            },
            ownerPubkeys,
          );
          placed += 1;
        } catch {
          failed.push(placement.name);
        }
      }
      return { placed, failed };
    },
    onSuccess: async ({ placed, failed }) => {
      await queryClient.invalidateQueries({
        queryKey: ["colony-managed-agent-heads"],
      });
      if (failed.length === 0) {
        toast.success(
          placed === 1 ? "1 agent placed." : `${placed} agents placed.`,
        );
        return;
      }
      // Partial success is the honest report: the ones that landed stay
      // landed, and naming the rest tells the owner what to retry.
      toast.warning(
        `${placed} placed, ${failed.length} could not be: ${failed
          .slice(0, 3)
          .join(", ")}${failed.length > 3 ? "…" : ""}`,
      );
    },
  });

  const label = backfillLabel(plan);
  if (!label) return null;

  return (
    <Button
      className="mt-3"
      data-testid="backfill-org-placement"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate(plan.placements)}
      size="sm"
      variant="secondary"
    >
      {mutation.isPending ? "Placing…" : label}
    </Button>
  );
}
