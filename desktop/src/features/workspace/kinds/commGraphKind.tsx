import type * as React from "react";

import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";
import type {
  TabKindContext,
  TabKindDefinition,
} from "@/features/workspace/lib/tabKindRegistry";
import {
  COMM_GRAPH_TAB_KIND,
  COMM_GRAPH_TAB_TITLE,
} from "@/features/factory/lib/commGraphTab";
import { isProjectChannel } from "@/features/factory/lib/projectChannel";
import { CommGraphTile } from "@/features/factory/ui/CommGraphTile";

/**
 * The communication graph tab.
 *
 * Offered in the same places the Factory is — a project channel — because the
 * graph answers a project question: who is talking to whom about this work
 * right now. It holds no payload: everything it draws is derived from relay
 * events the channel already has, so a restored tab needs nothing but its kind.
 */
export const commGraphKindDefinition: TabKindDefinition = {
  kind: COMM_GRAPH_TAB_KIND,
  label: COMM_GRAPH_TAB_TITLE,
  createTitle: () => COMM_GRAPH_TAB_TITLE,
  createPayload: () => ({}),
  canCreateFromNewTabPage: true,
  isAvailable: (context: TabKindContext) =>
    isProjectChannel(context.projects, context.channelId),
};

export function CommGraphBody({ channelId }: TabBodyProps): React.JSX.Element {
  return <CommGraphTile channelId={channelId} />;
}
