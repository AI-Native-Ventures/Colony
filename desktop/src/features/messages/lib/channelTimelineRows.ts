import { isTaskTransitionType } from "@/features/company/taskThreadEvents";
import type { RelayEvent } from "@/shared/api/types";
import {
  CHANNEL_TIMELINE_CONTENT_KINDS,
  KIND_SYSTEM_MESSAGE,
} from "@/shared/constants/kinds";

const CHANNEL_TIMELINE_KINDS = new Set<number>(CHANNEL_TIMELINE_CONTENT_KINDS);

/**
 * A relay-authored task lifecycle row: kind 40099 whose payload is one of the
 * task transition types.
 *
 * These belong to a task, not to the channel conversation. In the channel's
 * main timeline they land between real messages as relay-signed captions the
 * owner cannot delete, one per message that ever created a task. The row is
 * still stored and still renders inside the thread panel and the task thread
 * dialog; only the channel's main timeline drops it.
 *
 * A thread anchor makes no difference. An anchored row carrying only an `e`
 * `root` marker is exactly the shape the relay emits, and it still rendered at
 * channel level, so the rule is now unconditional on the tags.
 */
export function isTaskTransitionRow(event: RelayEvent): boolean {
  if (event.kind !== KIND_SYSTEM_MESSAGE) return false;
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
  return !isTaskTransitionRow(event);
}
