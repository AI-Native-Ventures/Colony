import {
  closeTab,
  getWorkspace,
} from "@/features/workspace/lib/workspaceTabs";
import { getTabKind } from "@/features/workspace/lib/tabKindRegistry";

export async function closeWorkspaceTab(
  channelId: string,
  tabId: string,
): Promise<void> {
  const workspace = getWorkspace(channelId);
  const tab = workspace.tabs.find((t) => t.id === tabId);
  if (!tab) {
    closeTab(channelId, tabId);
    return;
  }
  const definition = getTabKind(tab.kind);
  try {
    await Promise.resolve(definition?.dispose?.(tab));
  } catch (error: unknown) {
    console.error("Failed to dispose workspace tab:", error);
  }
  closeTab(channelId, tabId);
}
