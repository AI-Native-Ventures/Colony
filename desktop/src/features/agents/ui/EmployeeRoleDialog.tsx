import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { rankLabel, type AgentRank } from "@/features/agents/employeeHeads";
import { publishEmployeeUpdate } from "@/features/agents/orgActions";
import { escalationTarget, type OrgMember } from "@/features/agents/orgTree";
import type { DelegationGrant } from "@/features/agents/delegationGrants";
import { formatNanousdAsUsd } from "@/shared/api/tauriProvisionedCredits";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { AgentDropdownSelect } from "./agentConfigControls";

/**
 * Editing an agent's rank and reporting line.
 *
 * Both changes publish a kind-9046 update signed by the owner; the relay
 * re-validates everything at ingest and republishes the head from its row.
 * The manager picker narrows to agents exactly one rank up so an invalid
 * edge cannot be composed here -- but the relay remains the authority, and
 * its rejection is shown verbatim, never paraphrased.
 *
 * Promoting is not just a label: delegation grants are community-wide (a
 * grant has no holder, and authority resolves on rank alone), so moving an
 * agent up hands it every active grant immediately. The dialog states that,
 * listing what it confers, before the owner can commit.
 */

const RANK_ORDER: Record<AgentRank, number> = {
  worker: 0,
  leader: 1,
  executive: 2,
};

const ALL_RANKS: AgentRank[] = ["worker", "leader", "executive"];

/** Grants shown individually before the summary count takes over. */
const MAX_LISTED_GRANTS = 4;

export function isPromotion(current: AgentRank, next: AgentRank): boolean {
  return RANK_ORDER[next] > RANK_ORDER[current];
}

type EmployeeRoleDialogProps = {
  member: OrgMember;
  /** Every ranked member in the community; narrowed here per selection. */
  members: readonly OrgMember[];
  /** Active, owner-authored delegation grants (community-wide). */
  grants: readonly DelegationGrant[];
  isGrantsLoading: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function EmployeeRoleDialog({
  member,
  members,
  grants,
  isGrantsLoading,
  open,
  onOpenChange,
}: EmployeeRoleDialogProps) {
  const queryClient = useQueryClient();
  const [selectedRank, setSelectedRank] = React.useState<AgentRank>(
    member.rank,
  );
  // "" means no manager.
  const [selectedManager, setSelectedManager] = React.useState<string>(
    member.manager ?? "",
  );
  const [acknowledgedPromotion, setAcknowledgedPromotion] =
    React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setSelectedRank(member.rank);
    setSelectedManager(member.manager ?? "");
    setAcknowledgedPromotion(false);
  }, [open, member]);

  const promoting = isPromotion(member.rank, selectedRank);
  const managerTargetRank = escalationTarget(selectedRank);

  // Exactly one rung up, never the agent itself. The relay still validates.
  const managerCandidates = React.useMemo(
    () =>
      managerTargetRank
        ? members.filter(
            (candidate) =>
              candidate.pubkey !== member.pubkey &&
              candidate.rank === managerTargetRank,
          )
        : [],
    [members, managerTargetRank, member.pubkey],
  );

  // Keep the selection honest when a rank change invalidates it.
  React.useEffect(() => {
    if (!managerTargetRank) {
      if (selectedManager !== "") setSelectedManager("");
      return;
    }
    const current = members.find(
      (candidate) => candidate.pubkey === selectedManager,
    );
    if (!current || current.rank !== managerTargetRank) {
      if (member.manager && selectedManager === member.manager && !promoting) {
        return;
      }
      if (selectedManager !== "") setSelectedManager("");
    }
  }, [managerTargetRank, members, selectedManager, member.manager, promoting]);

  const rankChanged = selectedRank !== member.rank;
  const managerChanged =
    managerTargetRank !== null && selectedManager !== (member.manager ?? "");
  const canSubmit = rankChanged || managerChanged;

  const updateMutation = useMutation({
    mutationFn: async () => {
      await publishEmployeeUpdate({
        pubkey: member.pubkey,
        ...(rankChanged ? { rank: selectedRank } : {}),
        ...(managerTargetRank && selectedManager
          ? { manager: selectedManager }
          : {}),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["colony-employee-heads"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["colony-managed-agent-heads"],
        }),
      ]);
      onOpenChange(false);
    },
    // Errors stay in the dialog: the relay's message names the rule that
    // fired and is rendered verbatim below.
  });

  const submitLabel = promoting
    ? `Promote to ${rankLabel(selectedRank)}`
    : rankChanged
      ? `Move to ${rankLabel(selectedRank)}`
      : "Save reporting line";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" data-testid="employee-role-dialog">
        <DialogHeader>
          <DialogTitle>Edit role: {member.name}</DialogTitle>
          <DialogDescription>
            Changes are signed by you and validated by the workspace relay.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="employee-rank"
            >
              Rank
            </label>
            <AgentDropdownSelect
              id="employee-rank"
              onValueChange={(value) => {
                if (
                  value === "worker" ||
                  value === "leader" ||
                  value === "executive"
                ) {
                  setAcknowledgedPromotion(false);
                  setSelectedRank(value);
                }
              }}
              options={ALL_RANKS.map((rank) => ({
                label: rankLabel(rank),
                value: rank,
              }))}
              testId="employee-rank-select"
              value={selectedRank}
            />
          </div>

          {managerTargetRank ? (
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="employee-manager"
              >
                Manager
              </label>
              <AgentDropdownSelect
                emptyOptionsLabel={
                  managerTargetRank === "executive"
                    ? "No chiefs of staff yet"
                    : "No team leads yet"
                }
                id="employee-manager"
                onValueChange={(value) => {
                  setAcknowledgedPromotion(false);
                  setSelectedManager(value);
                }}
                options={[
                  { label: "No manager", value: "" },
                  ...managerCandidates.map((candidate) => ({
                    label: candidate.name,
                    value: candidate.pubkey,
                  })),
                ]}
                placeholder="No manager"
                placeholderValue=""
                testId="employee-manager-select"
                value={selectedManager}
              />
              <p className="text-xs text-muted-foreground">
                A {rankLabel(selectedRank).toLowerCase()} reports to a{" "}
                {rankLabel(managerTargetRank).toLowerCase()}. The relay refuses
                any other edge.
              </p>
            </div>
          ) : (
            <p
              className="text-xs text-muted-foreground"
              data-testid="employee-no-manager-note"
            >
              A {rankLabel(selectedRank).toLowerCase()} reports to no agent.
            </p>
          )}

          {promoting ? (
            <div
              className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3"
              data-testid="promotion-grant-warning"
            >
              <p className="text-sm font-medium text-foreground">
                Promoting {member.name} to {rankLabel(selectedRank)} gives it
                every active delegation in this community, immediately.
                Delegations belong to the community, not to one agent: any
                leader or executive may decide under them.
              </p>
              {isGrantsLoading ? (
                <p className="text-xs text-muted-foreground">
                  Checking active delegations...
                </p>
              ) : grants.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground"
                  data-testid="promotion-no-grants"
                >
                  No delegations are currently active, so this grants no
                  autonomous spending authority.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {grants.slice(0, MAX_LISTED_GRANTS).map((grant) => (
                    <p
                      className="text-xs text-foreground"
                      data-testid={`promotion-grant-${grant.grantId}`}
                      key={grant.grantId}
                    >
                      <span className="font-medium">{grant.category}</span>{" "}
                      scope {grant.scope}
                      {grant.capNanoUsd !== null
                        ? `, capped at ${formatNanousdAsUsd(String(grant.capNanoUsd))}`
                        : ", no spending cap"}
                    </p>
                  ))}
                  {grants.length > MAX_LISTED_GRANTS ? (
                    <p className="text-xs text-muted-foreground">
                      ...and {grants.length - MAX_LISTED_GRANTS} more active{" "}
                      {grants.length - MAX_LISTED_GRANTS === 1
                        ? "delegation"
                        : "delegations"}
                      .
                    </p>
                  ) : null}
                </div>
              )}
              {!isGrantsLoading ? (
                <div className="flex items-start gap-2 text-sm text-foreground">
                  <Checkbox
                    checked={acknowledgedPromotion}
                    data-testid="promotion-acknowledge-checkbox"
                    id="promotion-acknowledge"
                    onCheckedChange={(checked) => {
                      setAcknowledgedPromotion(checked === true);
                    }}
                  />
                  <label htmlFor="promotion-acknowledge">
                    I understand what this promotion confers.
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}

          {updateMutation.error ? (
            <p
              className="text-sm text-destructive"
              data-testid="employee-role-error"
              role="alert"
            >
              {(updateMutation.error as Error).message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            data-testid="employee-role-submit"
            disabled={
              !canSubmit ||
              updateMutation.isPending ||
              (promoting &&
                !isGrantsLoading &&
                grants.length > 0 &&
                !acknowledgedPromotion)
            }
            onClick={() => updateMutation.mutate()}
            type="button"
          >
            {updateMutation.isPending ? "Publishing..." : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
