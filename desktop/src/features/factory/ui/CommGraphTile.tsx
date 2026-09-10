import * as React from "react";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import {
  useAgentRoleTitles,
  useKnownAgentPubkeys,
} from "@/features/agents/useKnownAgentPubkeys";
import { agentRoleLabel } from "@/features/agents/agentIdentityPresentation";
import { useManagedAgentsQuery } from "@/features/agents/hooks";
import { useOpenAsks } from "@/features/asks/useOpenAsks";
import {
  useChannelMembersQuery,
  useChannelsQuery,
} from "@/features/channels/hooks";
import {
  buildCommGraph,
  pairInteractions,
  type CommGraphAsk,
  type CommInteraction,
} from "@/features/factory/lib/commGraph";
import {
  commGraphWindowMs,
  COMM_GRAPH_WINDOWS,
  type CommGraphWindowId,
} from "@/features/factory/lib/commGraphWindow";
import { CommGraphRail } from "@/features/factory/ui/CommGraphRail";
import {
  CommGraphSvg,
  type CommGraphPerson,
  type CommGraphSelection,
} from "@/features/factory/ui/CommGraphSvg";
import { useChannelMessagesQuery } from "@/features/messages/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { useUsersBatchQuery } from "@/features/profile/hooks";
import { useIdentityQuery } from "@/shared/api/hooks";
import { getInitials } from "@/shared/lib/initials";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { Button } from "@/shared/ui/button";

/** How often the window's "now" advances, so a 30-minute window stays honest. */
const CLOCK_INTERVAL_MS = 30_000;

export function CommGraphTile({
  channelId,
}: {
  channelId: string;
}): React.JSX.Element {
  const [windowId, setWindowId] = React.useState<CommGraphWindowId>("30m");
  const [selection, setSelection] = React.useState<CommGraphSelection>(null);
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const identity = useIdentityQuery();
  const ownerPubkey = normalizePubkey(identity.data?.pubkey ?? "");
  const channels = useChannelsQuery();
  const channel =
    channels.data?.find((candidate) => candidate.id === channelId) ?? null;
  const messages = useChannelMessagesQuery(channel);
  const members = useChannelMembersQuery(channelId);
  const knownAgents = useKnownAgentPubkeys();
  const managedAgents = useManagedAgentsQuery();
  const roleTitles = useAgentRoleTitles();
  const openAsks = useOpenAsks();

  // Agents in this channel: a member the community already recognises as an
  // agent. The channel roster is what scopes the graph — a managed agent that
  // never joined this channel is not part of this project's conversation.
  const agentPubkeys = React.useMemo(
    () =>
      (members.data ?? []).flatMap((member) => {
        const pubkey = normalizePubkey(member.pubkey);
        if (pubkey === ownerPubkey) return [];
        return member.isAgent || knownAgents.has(pubkey) ? [pubkey] : [];
      }),
    [members.data, knownAgents, ownerPubkey],
  );

  const asks = React.useMemo<CommGraphAsk[]>(
    () =>
      openAsks.asks
        // An ask carrying no channel cannot be excluded, so keep it: the filer
        // and audience still have to be a node pair for it to draw an edge.
        .filter((ask) => ask.channelId === null || ask.channelId === channelId)
        .map((ask) => ({
          id: ask.id,
          filerPubkey: ask.originalFilerPubkey ?? ask.filerPubkey,
          createdAt: ask.createdAt,
          headline: ask.headline,
          threadId: ask.threadId,
        })),
    [openAsks.asks, channelId],
  );

  const graph = React.useMemo(
    () =>
      buildCommGraph({
        events: messages.data ?? [],
        ownerPubkey,
        agentPubkeys,
        openAsks: asks,
        windowMs: commGraphWindowMs(windowId, now),
        now,
      }),
    [messages.data, ownerPubkey, agentPubkeys, asks, windowId, now],
  );

  const profilePubkeys = React.useMemo(
    () => graph.nodes.map((node) => node.pubkey),
    [graph.nodes],
  );
  const profiles = useUsersBatchQuery(profilePubkeys).data?.profiles;

  const people = React.useMemo(() => {
    const managedNames = new Map(
      (managedAgents.data ?? []).map((agent) => [
        normalizePubkey(agent.pubkey),
        agent.name,
      ]),
    );
    const entries = graph.nodes.map<[string, CommGraphPerson]>((node) => {
      const name = resolveUserLabel({
        pubkey: node.pubkey,
        currentPubkey: ownerPubkey,
        fallbackName: managedNames.get(node.pubkey) ?? null,
        profiles,
      });
      return [
        node.pubkey,
        {
          pubkey: node.pubkey,
          name,
          initials: getInitials(name),
          role:
            node.kind === "owner"
              ? "owner"
              : agentRoleLabel(roleTitles.get(node.pubkey)),
        },
      ];
    });
    return new Map(entries);
  }, [graph.nodes, managedAgents.data, ownerPubkey, profiles, roleTitles]);

  // A selected pair that no longer has a node (window change, agent left) is
  // dropped rather than rendering an empty rail headed by "Unknown".
  const activeSelection =
    selection !== null &&
    people.has(selection.a) &&
    people.has(selection.b) &&
    selection.a !== selection.b
      ? selection
      : null;

  const railInteractions = React.useMemo(
    () =>
      activeSelection === null
        ? []
        : pairInteractions(graph, activeSelection.a, activeSelection.b),
    [graph, activeSelection],
  );

  const navigation = useAppNavigation();
  const openThread = React.useCallback(
    (interaction: CommInteraction) => {
      if (interaction.kind === "ask") {
        if (!interaction.rootId) return;
        navigation.goChannel(channelId, {
          thread: interaction.rootId,
          threadRootId: interaction.rootId,
        });
        return;
      }
      navigation.goChannel(channelId, {
        messageId: interaction.id,
        threadRootId: interaction.rootId,
        ...(interaction.rootId ? { thread: interaction.rootId } : {}),
      });
    },
    [navigation, channelId],
  );

  const messageEdgeCount = graph.edges.filter(
    (edge) => edge.kind === "message",
  ).length;

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-hidden"
      data-testid="comm-graph-body"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
        <span
          className="text-xs text-muted-foreground"
          data-testid="comm-graph-summary"
        >
          Communication graph · {graph.nodes.length} node
          {graph.nodes.length === 1 ? "" : "s"} · {messageEdgeCount} edge
          {messageEdgeCount === 1 ? "" : "s"}
        </span>
        <div className="flex-1" />
        <Legend />
        <div className="flex items-center gap-1">
          {COMM_GRAPH_WINDOWS.map((option) => (
            <Button
              key={option.id}
              size="xs"
              variant={option.id === windowId ? "secondary" : "ghost"}
              data-testid={`comm-graph-window-${option.id}`}
              aria-pressed={option.id === windowId}
              onClick={() => setWindowId(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 p-2">
          <CommGraphSvg
            graph={graph}
            people={people}
            selection={activeSelection}
            onSelectPair={setSelection}
          />
        </div>
        <CommGraphRail
          pair={activeSelection}
          interactions={railInteractions}
          people={people}
          onOpenThread={openThread}
        />
      </div>
    </div>
  );
}

function Legend(): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-2 text-2xs text-muted-foreground"
      data-testid="comm-graph-legend"
    >
      <LegendChip className="bg-muted-foreground" label="message" />
      <LegendChip className="bg-primary" label="selected" />
      <LegendChip className="bg-warning" label="open ask" />
    </div>
  );
}

function LegendChip({
  className,
  label,
}: {
  className: string;
  label: string;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
      <span className={`h-1.5 w-1.5 rounded-full ${className}`} />
      {label}
    </span>
  );
}
