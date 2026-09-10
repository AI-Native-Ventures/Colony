import type * as React from "react";

import { isProjectChannel } from "@/features/factory/lib/projectChannel";
import { BoardTile } from "@/features/factory/ui/BoardTile";
import type { TabBodyProps } from "@/features/workspace/kinds/scratchpadKind";
import type {
  TabKindContext,
  TabKindDefinition,
} from "@/features/workspace/lib/tabKindRegistry";
import { openTab } from "@/features/workspace/lib/workspaceTabs";

/**
 * The tickets board, as a workspace tab kind.
 *
 * It carries no payload: the board is a view of the community's tasks scoped
 * to the channel the tab lives in, so the channel id the shell already hands
 * every body is the whole state. Offered only in a project channel, on the
 * same rule the Factory tab uses.
 */
export const boardKindDefinition: TabKindDefinition = {
  kind: "board",
  label: "Board",
  createTitle: () => "Board",
  createPayload: () => "",
  canCreateFromNewTabPage: true,
  isAvailable: (context: TabKindContext) =>
    isProjectChannel(context.projects, context.channelId),
};

/** Open a tickets board tab in this channel. Returns the new tab id. */
export function openBoardTab(channelId: string): string {
  return openTab(channelId, {
    kind: boardKindDefinition.kind,
    title: boardKindDefinition.createTitle(),
    createdBy: "local",
    payload: "",
  });
}

export function BoardBody(props: TabBodyProps): React.JSX.Element {
  return <BoardTile {...props} />;
}
