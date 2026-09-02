import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  isValidRoleSlug,
  rankLabel,
  type AgentRank,
} from "@/features/agents/employeeHeads";
import { publishHireRequest } from "@/features/agents/orgActions";
import { recordPendingHire } from "@/features/agents/pendingHires";
import { escalationTarget, type OrgMember } from "@/features/agents/orgTree";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";
import { AgentDropdownSelect } from "./agentConfigControls";

/**
 * Hiring an employee: role slug, display name, rank, optional manager.
 *
 * The request (kind 9045) is owner-signed; the relay mints the keypair and
 * publishes the head asynchronously. Closing the dialog therefore does NOT
 * mean the agent exists yet -- a pending row on the org chart on the Agents
 * page says the workspace is minting an identity until the head lands.
 */

const ALL_RANKS: AgentRank[] = ["worker", "leader", "executive"];

const MAX_NAME_LENGTH = 100;

export function roleSlugProblem(value: string): string | null {
  if (value.length === 0) return "A role slug is required.";
  if (!isValidRoleSlug(value)) {
    return "Use lowercase letters, digits, hyphens or underscores, starting with a letter or digit, up to 64 characters.";
  }
  return null;
}

type HireEmployeeDialogProps = {
  communityId: string;
  /** Every ranked member in the community; manager candidates narrow per rank. */
  members: readonly OrgMember[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function HireEmployeeDialog({
  communityId,
  members,
  open,
  onOpenChange,
}: HireEmployeeDialogProps) {
  const queryClient = useQueryClient();
  const [role, setRole] = React.useState("");
  const [name, setName] = React.useState("");
  const [rank, setRank] = React.useState<AgentRank>("worker");
  const [manager, setManager] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setRole("");
    setName("");
    setRank("worker");
    setManager("");
  }, [open]);

  const trimmedRole = role.trim();
  const slugProblem = open ? roleSlugProblem(trimmedRole.toLowerCase()) : null;
  // Role slugs are stored lowercased by the relay; publish the folded form
  // so the pending row's role matches the head that eventually lands.
  const normalizedRole = trimmedRole.toLowerCase();

  const managerTargetRank = escalationTarget(rank);
  const managerCandidates = React.useMemo(
    () =>
      managerTargetRank
        ? members.filter((candidate) => candidate.rank === managerTargetRank)
        : [],
    [members, managerTargetRank],
  );

  const canSubmit =
    slugProblem === null &&
    name.trim().length > 0 &&
    name.trim().length <= MAX_NAME_LENGTH;

  const hireMutation = useMutation({
    mutationFn: async () => {
      await publishHireRequest({
        role: normalizedRole,
        name: name.trim(),
        rank,
        manager: managerTargetRank && manager ? manager : null,
      });
    },
    onSuccess: () => {
      recordPendingHire(communityId, {
        role: normalizedRole,
        name: name.trim(),
        rank,
      });
      void queryClient.invalidateQueries({
        queryKey: ["colony-employee-heads"],
      });
      onOpenChange(false);
    },
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" data-testid="hire-employee-dialog">
        <DialogHeader>
          <DialogTitle>Hire an employee</DialogTitle>
          <DialogDescription>
            The workspace mints and holds this agent's identity. It appears in
            your org once its head lands.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="hire-role-slug"
            >
              Role slug
            </label>
            <Input
              aria-invalid={slugProblem !== null}
              data-testid="hire-role-input"
              id="hire-role-slug"
              onChange={(event) => setRole(event.target.value)}
              placeholder="sales-lead"
              value={role}
            />
            {slugProblem ? (
              <p
                className="text-xs text-destructive"
                data-testid="hire-role-error"
              >
                {slugProblem}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="hire-display-name"
            >
              Display name
            </label>
            <Input
              data-testid="hire-name-input"
              id="hire-display-name"
              maxLength={MAX_NAME_LENGTH}
              onChange={(event) => setName(event.target.value)}
              placeholder="Sift"
              value={name}
            />
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="hire-rank"
            >
              Rank
            </label>
            <AgentDropdownSelect
              id="hire-rank"
              onValueChange={(value) => {
                if (
                  value === "worker" ||
                  value === "leader" ||
                  value === "executive"
                ) {
                  setRank(value);
                  setManager("");
                }
              }}
              options={ALL_RANKS.map((option) => ({
                label: rankLabel(option),
                value: option,
              }))}
              testId="hire-rank-select"
              value={rank}
            />
          </div>

          {managerTargetRank ? (
            <div className="space-y-1.5">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="hire-manager"
              >
                Manager (optional)
              </label>
              <AgentDropdownSelect
                emptyOptionsLabel={
                  managerTargetRank === "executive"
                    ? "No chiefs of staff yet"
                    : "No team leads yet"
                }
                id="hire-manager"
                onValueChange={setManager}
                options={[
                  { label: "No manager", value: "" },
                  ...managerCandidates.map((candidate) => ({
                    label: candidate.name,
                    value: candidate.pubkey,
                  })),
                ]}
                placeholder="No manager"
                placeholderValue=""
                testId="hire-manager-select"
                value={manager}
              />
              <p className="text-xs text-muted-foreground">
                A {rankLabel(rank).toLowerCase()} reports to a{" "}
                {rankLabel(managerTargetRank).toLowerCase()}.
              </p>
            </div>
          ) : null}

          {hireMutation.error ? (
            <p
              className="text-sm text-destructive"
              data-testid="hire-error"
              role="alert"
            >
              {(hireMutation.error as Error).message}
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
            data-testid="hire-submit"
            disabled={!canSubmit || hireMutation.isPending}
            onClick={() => hireMutation.mutate()}
            type="button"
          >
            {hireMutation.isPending ? "Filing request..." : "File hire request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
