import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { rankLabel, type AgentRank } from "@/features/agents/employeeHeads";
import {
  publishEmployeeRetirement,
  publishEmployeeUpdate,
} from "@/features/agents/orgActions";
import { publishManagedAgentRankHead } from "@/features/agents/managedAgentHeads";
import { recordRetiredEmployee } from "@/features/agents/retiredEmployees";
import { managerCandidatesFor } from "@/features/agents/orgMembers";
import { escalationTarget, type OrgMember } from "@/features/agents/orgTree";
import type { DelegationGrant } from "@/features/agents/delegationGrants";
import { formatNanousdAsUsd } from "@/shared/api/tauriProvisionedCredits";
import { truncatePubkey } from "@/shared/lib/pubkey";
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
 * Editing an agent's rank and reporting line -- and, for hired employees,
 * retiring them.
 *
 * Two kinds of agent sit on the chart and they change through different
 * events. An employee changes through kind 9046, owner-signed like today. A
 * personal agent has no employee row for the relay to speak about: it changes
 * by republishing the owner-authored kind-30177 head it already has, now
 * carrying `tier` in content and a `manager` tag -- exactly the fields the
 * relay's `agent_tier` and `agent_manager` read back.
 *
 * Both paths are validated by the relay at ingest; the manager picker narrows
 * to agents exactly one rank up so an invalid edge cannot be composed here --
 * but the relay remains the authority, and its rejection is shown verbatim,
 * never paraphrased.
 *
 * Promoting is not just a label: delegation grants are community-wide (a
 * grant has no holder, and authority resolves on rank alone), so moving an
 * agent up hands it every active grant immediately. The dialog states that,
 * listing what it confers, before the owner can commit.
 *
 * Retirement is employees only (a personal agent is removed by deleting its
 * agent record instead). The relay refuses to retire a manager that still has
 * reports; its refusal names them by pubkey, and those pubkeys are listed
 * under the verbatim message so the owner knows what to reassign first.
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

/**
 * One editable member of the org. Employees always carry a rank; a personal
 * agent may not yet (that is exactly the unranked case this dialog exists to
 * close), so `rank` is nullable here.
 */
export type RoleDialogMember = {
  pubkey: string;
  name: string;
  role: string;
  rank: AgentRank | null;
  manager: string | null;
  isPersonalAgent: boolean;
};

const HEX64 = /[0-9a-f]{64}/g;

/**
 * The report pubkeys named in a retire refusal (`retire refused: <hex>, ...
 * still report to <target>; reassign them first`). The target itself is
 * never one of its own reports; anything else hex-shaped in an unrelated
 * refusal yields nothing usable.
 */
export function reportsFromRetireRefusal(
  message: string,
  targetPubkey: string,
): string[] {
  const found: string[] = [];
  for (const match of message.matchAll(HEX64)) {
    const pubkey = match[0];
    if (pubkey === targetPubkey) continue;
    if (!found.includes(pubkey)) found.push(pubkey);
  }
  return found;
}

type EmployeeRoleDialogProps = {
  communityId: string;
  member: RoleDialogMember;
  /** Every ranked member in the community; narrowed here per selection. */
  members: readonly OrgMember[];
  /** Active, owner-authored delegation grants (community-wide). */
  grants: readonly DelegationGrant[];
  isGrantsLoading: boolean;
  /** Current community owner pubkeys; head republish trusts nothing else. */
  ownerPubkeys: ReadonlySet<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function EmployeeRoleDialog({
  communityId,
  member,
  members,
  grants,
  isGrantsLoading,
  ownerPubkeys,
  open,
  onOpenChange,
}: EmployeeRoleDialogProps) {
  const queryClient = useQueryClient();
  const [selectedRank, setSelectedRank] = React.useState<AgentRank | null>(
    member.rank,
  );
  // "" means no manager.
  const [selectedManager, setSelectedManager] = React.useState<string>(
    member.manager ?? "",
  );
  const [acknowledgedPromotion, setAcknowledgedPromotion] =
    React.useState(false);
  const [acknowledgedRetirement, setAcknowledgedRetirement] =
    React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setSelectedRank(member.rank);
    setSelectedManager(member.manager ?? "");
    setAcknowledgedPromotion(false);
    setAcknowledgedRetirement(false);
  }, [open, member]);

  // A first rank assignment reads as "assigning", not "promoting"; only a
  // move up an existing ladder promotes. Both confer grants when they end at
  // leader or above, because a worker assignment hands over no authority.
  const promoting =
    member.rank !== null &&
    selectedRank !== null &&
    isPromotion(member.rank, selectedRank);
  const confersGrants =
    selectedRank !== null && isPromotion(member.rank ?? "worker", selectedRank);
  const managerTargetRank = selectedRank
    ? escalationTarget(selectedRank)
    : null;

  // Exactly one rung up, never the agent itself. The relay still validates.
  const managerCandidates = React.useMemo(
    () => managerCandidatesFor(members, member.pubkey, selectedRank),
    [members, member.pubkey, selectedRank],
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
      if (member.manager && selectedManager === member.manager) {
        return;
      }
      if (selectedManager !== "") setSelectedManager("");
    }
  }, [managerTargetRank, members, selectedManager, member.manager]);

  const rankChanged = selectedRank !== member.rank;
  const managerChanged =
    managerTargetRank !== null && selectedManager !== (member.manager ?? "");
  const canSubmit = selectedRank !== null && (rankChanged || managerChanged);

  const invalidateOrgQueries = React.useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: ["colony-employee-heads"],
      }),
      queryClient.invalidateQueries({
        queryKey: ["colony-managed-agent-heads"],
      }),
    ]);
  }, [queryClient]);

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedRank) {
        throw new Error("Pick a rank first.");
      }
      if (member.isPersonalAgent) {
        // A personal agent's rank lives on its own owner-authored head:
        // republish it with tier and manager, merged into the content every
        // other 30177 reader still needs.
        await publishManagedAgentRankHead(
          {
            pubkey: member.pubkey,
            name: member.name,
            tier: selectedRank,
            manager:
              managerTargetRank && selectedManager ? selectedManager : null,
          },
          ownerPubkeys,
        );
        return;
      }
      await publishEmployeeUpdate({
        pubkey: member.pubkey,
        ...(rankChanged ? { rank: selectedRank } : {}),
        ...(managerTargetRank && selectedManager
          ? { manager: selectedManager }
          : {}),
      });
    },
    onSuccess: async () => {
      await invalidateOrgQueries();
      onOpenChange(false);
    },
    // Errors stay in the dialog: the relay's message names the rule that
    // fired and is rendered verbatim below.
  });

  const retireMutation = useMutation({
    mutationFn: async () => {
      await publishEmployeeRetirement({ pubkey: member.pubkey });
    },
    onSuccess: async () => {
      // No head announces a retirement, so this device keeps the employee
      // off the chart itself. The record stays on the relay untouched.
      recordRetiredEmployee(communityId, {
        pubkey: member.pubkey,
        name: member.name,
      });
      await invalidateOrgQueries();
      onOpenChange(false);
    },
  });

  const submitLabel =
    member.rank === null
      ? selectedRank
        ? `Set rank to ${rankLabel(selectedRank)}`
        : "Set rank"
      : promoting
        ? `Promote to ${rankLabel(selectedRank ?? member.rank)}`
        : rankChanged
          ? `Move to ${rankLabel(selectedRank ?? member.rank)}`
          : "Save reporting line";

  const updateError = updateMutation.error as Error | null;
  const retireError = retireMutation.error as Error | null;
  const refusedReports = retireError
    ? reportsFromRetireRefusal(retireError.message, member.pubkey)
    : [];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" data-testid="employee-role-dialog">
        <DialogHeader>
          <DialogTitle>
            {member.isPersonalAgent ? "Set role: " : "Edit role: "}
            {member.name}
          </DialogTitle>
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
              placeholder={member.rank === null ? "Unranked" : "Select"}
              testId="employee-rank-select"
              value={selectedRank ?? ""}
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
                A {selectedRank ? rankLabel(selectedRank).toLowerCase() : ""}{" "}
                reports to a {rankLabel(managerTargetRank).toLowerCase()}. The
                relay refuses any other edge.
              </p>
            </div>
          ) : (
            <p
              className="text-xs text-muted-foreground"
              data-testid="employee-no-manager-note"
            >
              {selectedRank
                ? `A ${rankLabel(selectedRank).toLowerCase()} reports to no agent.`
                : "Pick a rank to choose a manager."}
            </p>
          )}

          {confersGrants ? (
            <div
              className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3"
              data-testid="promotion-grant-warning"
            >
              <p className="text-sm font-medium text-foreground">
                {member.rank === null ? "Assigning" : "Promoting"} {member.name}{" "}
                to {selectedRank ? rankLabel(selectedRank) : ""} gives it every
                active delegation in this community, immediately. Delegations
                belong to the community, not to one agent: any leader or
                executive may decide under them.
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

          {updateError ? (
            <p
              className="text-sm text-destructive"
              data-testid="employee-role-error"
              role="alert"
            >
              {updateError.message}
            </p>
          ) : null}

          {!member.isPersonalAgent ? (
            <div
              className="space-y-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
              data-testid="employee-retire-section"
            >
              <p className="text-sm font-medium text-foreground">
                Retire {member.name}
              </p>
              <p className="text-xs text-muted-foreground">
                Retirement removes {member.name} from the org chart and frees
                their role for a future hire. Their record, history, and past
                decisions are kept; this cannot be undone from here.
              </p>
              <div className="flex items-start gap-2 text-sm text-foreground">
                <Checkbox
                  checked={acknowledgedRetirement}
                  data-testid="employee-retire-acknowledge-checkbox"
                  id="employee-retire-acknowledge"
                  onCheckedChange={(checked) => {
                    setAcknowledgedRetirement(checked === true);
                  }}
                />
                <label htmlFor="employee-retire-acknowledge">
                  I understand {member.name} leaves the org chart.
                </label>
              </div>
              {retireError ? (
                <div data-testid="employee-retire-error" role="alert">
                  <p className="text-sm text-destructive">
                    {retireError.message}
                  </p>
                  {refusedReports.length > 0 ? (
                    <div
                      className="mt-2 space-y-1"
                      data-testid="employee-retire-reports"
                    >
                      <p className="text-xs font-medium text-foreground">
                        Still reporting to {member.name}; reassign them first:
                      </p>
                      <ul className="list-disc pl-5 text-xs text-muted-foreground">
                        {refusedReports.map((pubkey) => {
                          const name = members.find(
                            (candidate) => candidate.pubkey === pubkey,
                          )?.name;
                          return (
                            <li key={pubkey}>
                              {name ?? truncatePubkey(pubkey)}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <Button
                data-testid="employee-retire-submit"
                disabled={!acknowledgedRetirement || retireMutation.isPending}
                onClick={() => retireMutation.mutate()}
                type="button"
                variant="destructive"
              >
                {retireMutation.isPending
                  ? "Retiring..."
                  : `Retire ${member.name}`}
              </Button>
            </div>
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
              (confersGrants &&
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
