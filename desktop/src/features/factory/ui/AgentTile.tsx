import * as React from "react";

import { useActiveAgentTurns } from "@/features/agents/activeAgentTurnsStore";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { ManagedAgentSessionPanel } from "@/features/agents/ui/ManagedAgentSessionPanel";
import {
  parseAgentTabPayload,
  withThreadRootId,
} from "@/features/factory/lib/agentTabPayload";
import { deriveAgentTileStatus } from "@/features/factory/lib/agentTileStatus";
import { AgentTileComposer } from "@/features/factory/ui/AgentTileComposer";
import { AgentTileHeader } from "@/features/factory/ui/AgentTileHeader";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";
import { updateTabPayload } from "@/features/workspace/lib/workspaceTabs";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * One agent, as a workspace tile: who it is and how it is configured, the live
 * ACP transcript, and a composer bound to the thread this tile owns.
 */
export function AgentTile({ channelId, tab }: TabBodyProps): React.JSX.Element {
  const payload = parseAgentTabPayload(tab.payload);
  const agentsQuery = useManagedAgentsQuery();
  const agentPubkey = payload?.agentPubkey ?? "";
  const agent = React.useMemo(() => {
    if (!agentPubkey) return null;
    const wanted = normalizePubkey(agentPubkey);
    return (
      (agentsQuery.data ?? []).find(
        (candidate) => normalizePubkey(candidate.pubkey) === wanted,
      ) ?? null
    );
  }, [agentPubkey, agentsQuery.data]);
  const activeTurns = useActiveAgentTurns(agentPubkey || null);

  const handleThreadRooted = React.useCallback(
    (rootEventId: string) => {
      if (!payload) return;
      updateTabPayload(
        channelId,
        tab.id,
        withThreadRootId(payload, rootEventId),
      );
    },
    [channelId, payload, tab.id],
  );

  if (!payload) {
    return <AgentTileNotice>This agent tab could not be read.</AgentTileNotice>;
  }

  if (!agent) {
    // A pending first fetch is not the same as a missing agent: only claim the
    // agent is gone once the query has actually answered.
    return agentsQuery.isFetched ? (
      <AgentTileNotice testId="agent-tile-missing">
        This agent is no longer on this device.
      </AgentTileNotice>
    ) : (
      <AgentTileNotice>Loading agent...</AgentTileNotice>
    );
  }

  const status = deriveAgentTileStatus(agent, activeTurns.length > 0);

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden bg-background"
      data-agent-pubkey={agent.pubkey}
      data-testid="factory-agent-tile"
    >
      <AgentTileHeader agent={agent} status={status} />
      <ManagedAgentSessionPanel
        agent={agent}
        autoTail
        channelId={channelId}
        className="min-h-0 flex-1 rounded-none border-0 bg-transparent shadow-none"
        emptyDescription={`Message ${agent.name} to start a turn.`}
        panelPadding={false}
        showHeader={false}
        showRaw={false}
        transcriptContentClassName="px-3 py-2"
        transcriptVariant="compactPreview"
      />
      <AgentTileComposer
        agentName={agent.name}
        agentPubkey={agent.pubkey}
        channelId={channelId}
        onThreadRooted={handleThreadRooted}
        threadRootId={payload.threadRootId}
      />
    </div>
  );
}

function AgentTileNotice({
  children,
  testId = "agent-tile-notice",
}: {
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex h-full min-h-0 items-center justify-center px-4 text-center text-sm text-muted-foreground"
      data-testid={testId}
    >
      {children}
    </div>
  );
}
