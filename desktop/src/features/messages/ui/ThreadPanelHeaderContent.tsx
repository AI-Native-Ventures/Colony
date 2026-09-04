import * as React from "react";
import { toast } from "sonner";
import { CheckCheck } from "lucide-react";

import { useThreadOpenTask } from "@/features/company/hooks";
import { threadTasksQueryKey } from "@/features/company/hooks";
import { queueActioner } from "@/features/company/queueActions";
import { threadTaskHeader } from "@/features/company/threadTaskHeaderModel";
import { useMyRelayMembershipQuery } from "@/features/community-members/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import type { ChannelType } from "@/shared/api/types";
import {
  AuxiliaryPanelHeaderGroup,
  AuxiliaryPanelTitle,
} from "@/shared/layout/AuxiliaryPanel";
import { Button } from "@/shared/ui/button";
import { useQueryClient } from "@tanstack/react-query";

import type { TimelineMessage } from "@/features/messages/types";

import { ThreadReadStateToggle } from "./ThreadReadStateToggle";

/**
 * The thread panel's header: where the thread is, and what work is open in it.
 *
 * A thread holds at most one open task, and the header is the one place a
 * member reading the conversation can see which one they are talking about
 * and say it is finished. Closing it from a task list instead would mean
 * leaving the conversation to end the work the conversation is about.
 *
 * "Mark done" is the owner's close, not an assignee's report: an agent
 * finishing its own share publishes a completion report, and the task closes
 * on its own once every assignee has. The button is therefore shown only to
 * the community owner, who is the only member whose signature the relay
 * accepts on a Company Action.
 */
export function ThreadPanelHeaderContent({
  channelId,
  channelName,
  channelType,
  headerLeading,
  isFocusMode,
  isSinglePanelView,
  onClose,
  onMarkRead,
  onMarkUnread,
  showWorkspaceContext,
  threadHead,
  threadRootId,
  threadRootSummary,
  threadUnreadCount,
}: {
  channelId: string | null;
  channelName: string;
  channelType: ChannelType | null;
  headerLeading?: React.ReactNode;
  isFocusMode?: boolean;
  isSinglePanelView: boolean;
  onClose?: () => void;
  onMarkRead?: (message: TimelineMessage) => void;
  onMarkUnread?: (message: TimelineMessage) => void;
  showWorkspaceContext: boolean;
  threadHead: TimelineMessage;
  threadRootId: string | null;
  threadRootSummary: string | null;
  threadUnreadCount?: number;
}) {
  const queryClient = useQueryClient();
  const { activeCommunity } = useCommunities();
  const communityId = activeCommunity?.id ?? "";
  const membershipQuery = useMyRelayMembershipQuery();
  const openTask = useThreadOpenTask(communityId, {
    channelId,
    channelType,
    threadRootId,
  });
  const [isClosing, setIsClosing] = React.useState(false);
  const header = threadTaskHeader(openTask, membershipQuery.data?.role);

  const markDone = async () => {
    if (!openTask) return;
    setIsClosing(true);
    try {
      const outcome = await queueActioner.completeTask(
        openTask.id,
        "Marked done from the thread.",
      );
      if (outcome.status === "blocked") {
        toast.error(outcome.message);
        return;
      }
      toast.success("Task marked done.");
      await queryClient.invalidateQueries({
        queryKey: threadTasksQueryKey(communityId, threadRootId ?? ""),
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "That task could not be closed.",
      );
    } finally {
      setIsClosing(false);
    }
  };

  return (
    <>
      <AuxiliaryPanelHeaderGroup
        backButtonAriaLabel="Back to conversation"
        backButtonTestId="message-thread-back"
        // A focus drawer only sets `isSinglePanelView` to fill its
        // container's width. It is not the narrow single-column view, and it
        // has the scrimmed sliver as its way back, so it takes no back
        // control of its own. The narrow view still needs one.
        leading={headerLeading}
        onBack={isSinglePanelView && !isFocusMode ? onClose : undefined}
      >
        <div className="min-w-0 flex-1">
          <AuxiliaryPanelTitle>
            {showWorkspaceContext ? `#${channelName}` : "Thread"}
          </AuxiliaryPanelTitle>
          {header.title ? (
            <p
              className="truncate text-xs text-muted-foreground"
              data-testid="thread-open-task-title"
              title={header.title}
            >
              {header.title}
            </p>
          ) : threadRootSummary ? (
            <p
              className="truncate text-xs text-muted-foreground"
              title={threadRootSummary}
            >
              {threadRootSummary}
            </p>
          ) : null}
        </div>
      </AuxiliaryPanelHeaderGroup>
      {header.canMarkDone ? (
        <Button
          className="shrink-0"
          data-testid="thread-mark-done"
          disabled={isClosing}
          onClick={markDone}
          size="sm"
          variant="ghost"
        >
          <CheckCheck aria-hidden />
          Mark done
        </Button>
      ) : null}
      <ThreadReadStateToggle
        isUnread={(threadUnreadCount ?? 0) > 0}
        message={threadHead}
        onMarkRead={onMarkRead}
        onMarkUnread={onMarkUnread}
      />
    </>
  );
}
