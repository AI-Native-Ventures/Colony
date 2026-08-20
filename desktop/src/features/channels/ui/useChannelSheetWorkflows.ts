import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useChannelWorkflowsQuery } from "@/features/workflows/hooks";
import type { Workflow } from "@/shared/api/types";
import { useWorkflowEditorOverlay } from "@/shared/context/WorkflowEditorOverlayContext";
import { useFeatureEnabled } from "@/shared/features";

/**
 * Workflow wiring for the channel management sheet.
 *
 * Lives outside `ChannelManagementSheet` because that file sits against the
 * desktop size ratchet, and the upstream editor commit adds more to it than it
 * has room for. The behaviour is upstream's unchanged: workflows open as a
 * modal above the sheet's Workflows view, so every close path returns to the
 * surface that opened them, and the navigation fallbacks close the sheet first
 * when no overlay is mounted.
 */
export function useChannelSheetWorkflows({
  channelId,
  open,
  closeSheet,
}: {
  channelId: string | null;
  open: boolean;
  closeSheet: () => void;
}) {
  const { goNewWorkflowForChannel, goWorkflow } = useAppNavigation();
  const {
    openNewWorkflow: openNewWorkflowOverlay,
    openWorkflow: openWorkflowOverlay,
  } = useWorkflowEditorOverlay();
  const workflowsEnabled = useFeatureEnabled("workflows");
  const workflowsQuery = useChannelWorkflowsQuery(
    workflowsEnabled && channelId !== null && open ? channelId : null,
  );

  function handleOpenWorkflow(workflow: Workflow) {
    if (openWorkflowOverlay) {
      openWorkflowOverlay(workflow.id, workflow);
      return;
    }

    closeSheet();
    void goWorkflow(workflow.id);
  }

  function handleCreateWorkflow() {
    if (!channelId) return;

    if (openNewWorkflowOverlay) {
      openNewWorkflowOverlay(channelId);
      return;
    }

    closeSheet();
    void goNewWorkflowForChannel(channelId);
  }

  return {
    workflowsEnabled,
    workflowsQuery,
    handleCreateWorkflow,
    handleOpenWorkflow,
  };
}
