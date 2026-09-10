import * as React from "react";

import { useActiveAgentTurns } from "@/features/agents/activeAgentTurnsStore";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { ManagedAgentSessionPanel } from "@/features/agents/ui/ManagedAgentSessionPanel";
import { useChannelsQuery } from "@/features/channels/hooks";
import { useChannelPanelHistoryState } from "@/features/channels/ui/useChannelPanelHistoryState";
import {
  parseAgentTabPayload,
  withThreadRootId,
} from "@/features/factory/lib/agentTabPayload";
import { deriveDelegationCards } from "@/features/factory/lib/delegation";
import { deriveAgentTileStatus } from "@/features/factory/lib/agentTileStatus";
import { AgentTileComposer } from "@/features/factory/ui/AgentTileComposer";
import { AgentTileDelegationCards } from "@/features/factory/ui/AgentTileDelegationCards";
import { AgentTileHeader } from "@/features/factory/ui/AgentTileHeader";
import { AgentTileMenu } from "@/features/factory/ui/AgentTileMenu";
import {
  DelegateAgentDialog,
  type DelegateTarget,
} from "@/features/factory/ui/DelegateAgentDialog";
import { useFactoryTileActions } from "@/features/factory/ui/FactoryTileContext";
import { useThreadReplies } from "@/features/messages/useThreadReplies";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";
import { setChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";
import { updateTabPayload } from "@/features/workspace/lib/workspaceTabs";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * One agent, as a workspace tile: who it is and how it is configured, the work
 * it was handed, the live ACP transcript, and a composer bound to the thread
 * this tile owns.
 */
export function AgentTile({ channelId, tab }: TabBodyProps): React.JSX.Element {
  const payload = parseAgentTabPayload(tab.payload);
  const agentsQuery = useManagedAgentsQuery();
  const agentPubkey = payload?.agentPubkey ?? "";
  const threadRootId = payload?.threadRootId ?? null;
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
  const tileActions = useFactoryTileActions();
  const { setOpenThreadHeadId } = useChannelPanelHistoryState();
  const [delegateTarget, setDelegateTarget] =
    React.useState<DelegateTarget | null>(null);

  // Both halves of a delegation live in this tile's thread, so the cards come
  // from the same replies the thread panel would show.
  const channelsQuery = useChannelsQuery();
  const channel = React.useMemo(
    () =>
      (channelsQuery.data ?? []).find(
        (candidate) => candidate.id === channelId,
      ) ?? null,
    [channelId, channelsQuery.data],
  );
  const threadReplies = useThreadReplies(channel, threadRootId);
  const nameFor = React.useCallback(
    (pubkey: string) => {
      const wanted = normalizePubkey(pubkey);
      const known = (agentsQuery.data ?? []).find(
        (candidate) => normalizePubkey(candidate.pubkey) === wanted,
      );
      if (known) return known.name;
      const tile = (tileActions?.agents ?? []).find(
        (candidate) => normalizePubkey(candidate.pubkey) === wanted,
      );
      return tile?.title ?? `${pubkey.slice(0, 8)}…`;
    },
    [agentsQuery.data, tileActions?.agents],
  );
  const cards = React.useMemo(
    () =>
      deriveDelegationCards({
        events: threadReplies.data ?? [],
        agentPubkey,
        nameFor,
      }),
    [agentPubkey, nameFor, threadReplies.data],
  );

  // Any other managed agent on this device can be handed work: an agent
  // without a tile yet gets one, which is the point of delegating.
  const delegates = React.useMemo(
    () =>
      (agentsQuery.data ?? [])
        .filter(
          (candidate) =>
            normalizePubkey(candidate.pubkey) !== normalizePubkey(agentPubkey),
        )
        .map((candidate) => ({
          pubkey: candidate.pubkey,
          name: candidate.name,
        })),
    [agentPubkey, agentsQuery.data],
  );

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

  const openThread = React.useCallback(() => {
    if (!threadRootId) return;
    setChannelSurfaceMode(channelId, "timeline");
    setOpenThreadHeadId(threadRootId);
  }, [channelId, setOpenThreadHeadId, threadRootId]);

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
      <AgentTileHeader
        agent={agent}
        menu={
          <AgentTileMenu
            actions={tileActions}
            agent={agent}
            delegates={delegates}
            onDelegate={setDelegateTarget}
            onNewDelegate={() =>
              tileActions?.openLauncher(`Delegated by ${agent.name}: `)
            }
            onOpenTerminal={() => {
              if (!agent.workingDir) return;
              tileActions?.openTerminalHere(tab.id, {
                cwd: agent.workingDir,
                title: `Terminal · ${agent.name}`,
              });
            }}
          />
        }
        status={status}
      />
      <AgentTileDelegationCards
        cards={cards}
        onOpenThread={threadRootId ? openThread : null}
      />
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
        threadRootId={threadRootId}
      />
      <DelegateAgentDialog
        channelId={channelId}
        delegator={{
          pubkey: agent.pubkey,
          name: agent.name,
          threadRootId,
        }}
        onOpenChange={(open) => {
          if (!open) setDelegateTarget(null);
        }}
        onSent={({ threadRootId: rooted }) => {
          handleThreadRooted(rooted);
          if (delegateTarget) {
            tileActions?.openAgentBeside(tab.id, {
              pubkey: delegateTarget.pubkey,
              name: delegateTarget.name,
              threadRootId: rooted,
            });
          }
          void threadReplies.refetch();
          setDelegateTarget(null);
        }}
        open={delegateTarget !== null}
        target={delegateTarget}
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
