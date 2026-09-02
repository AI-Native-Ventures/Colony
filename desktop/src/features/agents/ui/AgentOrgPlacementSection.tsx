import * as React from "react";

import { rankLabel, type AgentRank } from "@/features/agents/employeeHeads";
import {
  managerCandidatesFor,
  useOrgMembers,
} from "@/features/agents/orgMembers";
import { escalationTarget } from "@/features/agents/orgTree";
import { useCommunities } from "@/features/communities/useCommunities";
import { AgentDropdownSelect } from "./agentConfigControls";

/**
 * Org rank + manager for an agent being created.
 *
 * Stateless by design: the create dialog owns the draft so its submit can
 * carry the placement through its options, and this component owns
 * everything else -- which agents may manage whom (exactly one rung up, the
 * relay still authorizes), and where those candidates come from.
 */

const ALL_ORG_RANKS: AgentRank[] = ["worker", "leader", "executive"];

export type OrgPlacementDraft = {
  /** "" means unranked: publish no rank at all. */
  rank: AgentRank | "";
  manager: string;
};

export function emptyOrgPlacementDraft(): OrgPlacementDraft {
  return { rank: "", manager: "" };
}

export function AgentOrgPlacementSection({
  allowUnranked = true,
  disabled = false,
  selfPubkey = "",
  value,
  onChange,
}: {
  /**
   * Offer "Unranked". True while creating (the agent has no placement yet);
   * false while editing, where every placement the dialog can publish names
   * a rank and clearing one is not an operation the relay has.
   */
  allowUnranked?: boolean;
  disabled?: boolean;
  /**
   * The agent being placed, so it is never offered as its own manager. Empty
   * while creating: the agent does not exist yet, so it cannot be a candidate.
   */
  selfPubkey?: string;
  value: OrgPlacementDraft;
  onChange: (next: OrgPlacementDraft) => void;
}) {
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const { members } = useOrgMembers(communityId);
  const rankValue = value.rank === "" ? null : value.rank;
  const managerTargetRank = rankValue ? escalationTarget(rankValue) : null;
  const managerCandidates = React.useMemo(
    () => managerCandidatesFor(members, selfPubkey, rankValue),
    [members, selfPubkey, rankValue],
  );

  return (
    <div className="space-y-3" data-testid="agent-org-placement">
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="agent-org-rank"
        >
          Org rank
        </label>
        <AgentDropdownSelect
          disabled={disabled}
          id="agent-org-rank"
          onValueChange={(next) => {
            if (
              next === "" ||
              next === "worker" ||
              next === "leader" ||
              next === "executive"
            ) {
              if (next !== value.rank) {
                onChange({ rank: next, manager: "" });
              }
            }
          }}
          options={[
            ...(allowUnranked ? [{ label: "Unranked", value: "" }] : []),
            ...ALL_ORG_RANKS.map((rank) => ({
              label: rankLabel(rank),
              value: rank,
            })),
          ]}
          placeholder="Unranked"
          testId="agent-org-rank-select"
          value={value.rank}
        />
        <p className="text-xs text-muted-foreground">
          Where this agent sits in the community org. You can change it later
          under People and roles.
        </p>
      </div>
      {managerTargetRank ? (
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="agent-org-manager"
          >
            Manager
          </label>
          <AgentDropdownSelect
            emptyOptionsLabel={
              managerTargetRank === "executive"
                ? "No chiefs of staff yet"
                : "No team leads yet"
            }
            disabled={disabled}
            id="agent-org-manager"
            onValueChange={(next) => {
              onChange({ ...value, manager: next });
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
            testId="agent-org-manager-select"
            value={value.manager}
          />
          <p className="text-xs text-muted-foreground">
            A {rankLabel(rankValue ?? "worker").toLowerCase()} reports to a{" "}
            {rankLabel(managerTargetRank).toLowerCase()}.
          </p>
        </div>
      ) : null}
    </div>
  );
}
