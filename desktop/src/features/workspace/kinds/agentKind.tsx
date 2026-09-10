import type * as React from "react";

import { createAgentTabPayload } from "@/features/factory/lib/agentTabPayload";
import { isProjectChannel } from "@/features/factory/lib/projectChannel";
import { AgentTile } from "@/features/factory/ui/AgentTile";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";
import type {
  TabKindContext,
  TabKindDefinition,
} from "@/features/workspace/lib/tabKindRegistry";
import { openTab } from "@/features/workspace/lib/workspaceTabs";

export const agentKindDefinition: TabKindDefinition = {
  kind: "agent",
  label: "Agent",
  // The registry creates titles without context, so a tab created through it
  // has no agent to name yet. Every real agent tab is opened by
  // `openAgentTab`, which passes the agent's display name as the title.
  createTitle: () => "Agent",
  createPayload: () => createAgentTabPayload(""),
  // Not offered on the new-tab page: an agent tab only means something once an
  // agent is bound to it, which the Factory launcher does.
  canCreateFromNewTabPage: false,
  isAvailable: (context: TabKindContext) =>
    isProjectChannel(context.projects, context.channelId),
};

/** Open a tab bound to a managed agent. Returns the new tab id. */
export function openAgentTab(
  channelId: string,
  agentPubkey: string,
  title: string,
): string {
  return openTab(channelId, {
    kind: agentKindDefinition.kind,
    title,
    createdBy: "local",
    payload: createAgentTabPayload(agentPubkey),
  });
}

export function AgentBody(props: TabBodyProps): React.JSX.Element {
  return <AgentTile {...props} />;
}
