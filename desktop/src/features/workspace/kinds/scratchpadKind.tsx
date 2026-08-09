import type * as React from "react";

import type { TabKindDefinition } from "@/features/workspace/lib/tabKindRegistry";
import {
  updateTabPayload,
  type WorkspaceTab,
} from "@/features/workspace/lib/workspaceTabs";

/** Props every tab body receives. Bodies own their toolbar and their state. */
export type TabBodyProps = {
  channelId: string;
  tab: WorkspaceTab;
};

/**
 * Read the text out of a scratchpad payload.
 *
 * Payloads are persisted, so a payload written by an older build can reach a
 * newer one. Anything unexpected reads as empty rather than throwing.
 */
export function readScratchpadText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const text = (payload as Record<string, unknown>).text;
  return typeof text === "string" ? text : "";
}

export const scratchpadKindDefinition: TabKindDefinition = {
  kind: "scratchpad",
  label: "Scratchpad",
  createTitle: () => "Untitled",
  createPayload: () => ({ text: "" }),
  canCreateFromNewTabPage: true,
};

/** A plain local notepad. No relay, no agent, no persistence beyond the tab. */
export function ScratchpadBody({
  channelId,
  tab,
}: TabBodyProps): React.JSX.Element {
  const text = readScratchpadText(tab.payload);
  return (
    <textarea
      aria-label={`Scratchpad: ${tab.title}`}
      className="h-full w-full resize-none bg-transparent p-4 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
      data-testid="workspace-scratchpad-body"
      onChange={(event) =>
        updateTabPayload(channelId, tab.id, { text: event.target.value })
      }
      placeholder="Notes, snippets, anything. Local to this channel."
      spellCheck={false}
      value={text}
    />
  );
}
