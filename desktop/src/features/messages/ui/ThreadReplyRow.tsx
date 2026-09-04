import type * as React from "react";

import { MessageRow } from "./MessageRow";
import {
  isTaskTransitionMessage,
  TaskTransitionRow,
} from "./TaskTransitionRow";

export type { ThreadDepthGuideAction } from "./MessageRow";

/**
 * One row in the thread panel: a message, or a task lifecycle caption.
 *
 * Kind:40099 task transition rows live in the thread rather than the channel
 * timeline (PR #619 moved them), and the thread panel had no renderer for
 * them, so they fell through to `MessageRow` and printed their JSON payload
 * attributed to the relay's own pubkey. Routing every thread row through this
 * component keeps the split in one place: the head and the replies cannot
 * disagree about what a system row looks like.
 */
export function ThreadReplyRow(props: React.ComponentProps<typeof MessageRow>) {
  if (isTaskTransitionMessage(props.message)) {
    return <TaskTransitionRow message={props.message} />;
  }
  return <MessageRow {...props} />;
}
