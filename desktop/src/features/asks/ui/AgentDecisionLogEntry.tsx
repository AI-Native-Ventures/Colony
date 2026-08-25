import * as React from "react";
import { ScrollText } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { useCommunities } from "@/features/communities/useCommunities";
import { ProfileIngressRow } from "@/features/profile/ui/ProfileIngressRow";

import { DecisionLogDialog } from "./DecisionLogDialog";

/**
 * The one entry point into an agent's decision log, mounted wherever that
 * agent is named: the org chart node and the profile panel. The dialog opens
 * pre-filtered to this agent; "All agents" inside widens it to the whole
 * community's record.
 */
export function AgentDecisionLogEntry({
  agentName,
  pubkey,
}: {
  agentName?: string;
  pubkey: string;
}) {
  const [open, setOpen] = React.useState(false);
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const label = `Decision log for ${agentName ?? pubkey}`;

  return (
    <>
      <Button
        aria-label={label}
        data-testid={`decision-log-entry-${pubkey}`}
        onClick={() => setOpen(true)}
        size="sm"
        variant="ghost"
      >
        Decisions
      </Button>
      {open ? (
        <DecisionLogDialog
          agentNames={
            agentName === undefined ? undefined : { [pubkey]: agentName }
          }
          communityId={communityId}
          initialAgentPubkey={pubkey}
          onOpenChange={setOpen}
          open={open}
        />
      ) : null}
    </>
  );
}

/**
 * The same entry point dressed as a profile-panel row, matching the
 * "Activity log" ingress above which it renders.
 */
export function AgentDecisionLogIngressRow({
  agentName,
  pubkey,
}: {
  agentName?: string;
  pubkey: string;
}) {
  const [open, setOpen] = React.useState(false);
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";

  return (
    <>
      <ProfileIngressRow
        icon={ScrollText}
        label="Decision log"
        onClick={() => setOpen(true)}
        testId={`user-profile-decision-log-${pubkey}`}
      />
      {open ? (
        <DecisionLogDialog
          agentNames={
            agentName === undefined ? undefined : { [pubkey]: agentName }
          }
          communityId={communityId}
          initialAgentPubkey={pubkey}
          onOpenChange={setOpen}
          open={open}
        />
      ) : null}
    </>
  );
}
