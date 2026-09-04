import * as React from "react";

import { useThreadOpenTask } from "@/features/company/hooks";
import { useCommunities } from "@/features/communities/useCommunities";
import type { ChannelType } from "@/shared/api/types";
import { Switch } from "@/shared/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

/**
 * The composer's "New task" switch.
 *
 * A thread holds one open task, and every message in it is charged to that
 * task. That is right nearly always and wrong when two things are being
 * worked on in one conversation, so the switch is how a member says "this one
 * is separate" without leaving the thread. It only appears where it means
 * something: a thread, or a DM, that already has work open. On a channel
 * timeline there is nothing to start a second task beside.
 *
 * The state is per-send rather than a mode. Leaving it on would quietly open
 * a task per message, which is the behaviour thread-scoped tasks exist to end.
 */
function ComposerNewTaskToggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex w-fit items-center gap-1.5 px-1 pb-1 text-2xs text-muted-foreground">
          <Switch
            aria-label="New task"
            checked={checked}
            data-testid="composer-new-task"
            onCheckedChange={onCheckedChange}
          />
          <span>New task</span>
        </div>
      </TooltipTrigger>
      <TooltipContent>Start a separate task in this thread</TooltipContent>
    </Tooltip>
  );
}

export type ComposerNewTaskState = {
  /** Whether this thread or DM already holds an open task. */
  hasOpenTask: boolean;
  /** Read at send time, so a switch flipped during an upload still counts. */
  isRequested: () => boolean;
  /** Called once the send that carried the switch has gone out. */
  consume: () => void;
  /** The control itself, or `null` where it would mean nothing. */
  control: React.ReactNode;
};

export function useComposerNewTask(
  channelId: string | null,
  channelType: ChannelType | null,
  threadRootId: string | null,
): ComposerNewTaskState {
  const { activeCommunity } = useCommunities();
  const openTask = useThreadOpenTask(activeCommunity?.id ?? "", {
    channelId,
    channelType,
    threadRootId,
  });
  // The request is remembered against the conversation it was made in rather
  // than as a bare boolean, so moving to another thread drops it without an
  // effect having to notice the move.
  const scope = `${channelId ?? ""}:${threadRootId ?? ""}`;
  const [requestedScope, setRequestedScope] = React.useState<string | null>(
    null,
  );
  const requested = requestedScope === scope;
  const hasOpenTask = openTask !== null;
  const stateRef = React.useRef({ requested, hasOpenTask });
  stateRef.current = { requested, hasOpenTask };

  const isRequested = React.useCallback(
    () => stateRef.current.requested && stateRef.current.hasOpenTask,
    [],
  );
  const consume = React.useCallback(() => setRequestedScope(null), []);

  return {
    hasOpenTask,
    isRequested,
    consume,
    control: hasOpenTask ? (
      <ComposerNewTaskToggle
        checked={requested}
        onCheckedChange={(next) => setRequestedScope(next ? scope : null)}
      />
    ) : null,
  };
}
