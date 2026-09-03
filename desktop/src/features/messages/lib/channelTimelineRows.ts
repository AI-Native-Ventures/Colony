import { isTaskTransitionType } from "@/features/company/taskThreadEvents";
import type { RelayEvent } from "@/shared/api/types";
import {
  CHANNEL_TIMELINE_CONTENT_KINDS,
  KIND_SYSTEM_MESSAGE,
} from "@/shared/constants/kinds";

const CHANNEL_TIMELINE_KINDS = new Set<number>(CHANNEL_TIMELINE_CONTENT_KINDS);

function hasThreadAnchorTag(tags: string[][]): boolean {
  return tags.some(
    (tag) =>
      tag[0] === "e" &&
      typeof tag[1] === "string" &&
      (tag[3] === "root" || tag[3] === "reply"),
  );
}

/**
 * A relay-authored task lifecycle row (kind 40099, a task transition payload)
 * with no thread anchor.
 *
 * These belong to a task, not to the channel conversation. Unanchored, they
 * land between real messages as relay-signed captions the owner cannot delete,
 * one per message that ever created a task. The row is still stored and still
 * renders inside the task thread and thread dialogs; only the channel's main
 * timeline drops it.
 */
function isUnanchoredTaskTransition(event: RelayEvent): boolean {
  if (event.kind !== KIND_SYSTEM_MESSAGE) return false;
  if (hasThreadAnchorTag(event.tags)) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(event.content);
  } catch {
    return false;
  }
  if (typeof payload !== "object" || payload === null) return false;
  const type = (payload as { type?: unknown }).type;
  return typeof type === "string" && isTaskTransitionType(type);
}

/**
 * Whether an event belongs in a channel's main timeline.
 *
 * The single decision point for both the live append path and paged history,
 * so a row that is wrong at channel level cannot arrive through the other one.
 */
export function isChannelTimelineRow(event: RelayEvent): boolean {
  if (!CHANNEL_TIMELINE_KINDS.has(event.kind)) return false;
  return !isUnanchoredTaskTransition(event);
}
