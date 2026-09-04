import {
  describeTaskTransition,
  isTaskTransitionType,
} from "@/features/company/taskThreadEvents";
import type { TimelineMessage } from "@/features/messages/types";
import { KIND_SYSTEM_MESSAGE } from "@/shared/constants/kinds";
import { cn } from "@/shared/lib/cn";

/**
 * The relay-authored task transition payload carried by a kind:40099 row, or
 * null when the message is not one.
 *
 * Parsing is the membership test: a row counts only when its content is JSON
 * whose `type` is one of the seven transitions, which is the same rule
 * `isTaskTransitionRow` applies to the raw event at channel level.
 */
export function parseTaskTransitionPayload(
  message: TimelineMessage,
): Record<string, unknown> | null {
  if (message.kind !== KIND_SYSTEM_MESSAGE) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(message.body);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    return null;
  const type = (payload as { type?: unknown }).type;
  if (typeof type !== "string" || !isTaskTransitionType(type)) return null;
  return payload as Record<string, unknown>;
}

/** Whether a timeline message is a relay-authored task transition row. */
export function isTaskTransitionMessage(message: TimelineMessage): boolean {
  return parseTaskTransitionPayload(message) !== null;
}

/**
 * A task lifecycle row inside a thread.
 *
 * These belong to the task, not to the conversation, so they render as a
 * caption rather than a message: no avatar, no reactions, no reply or thread
 * affordances, and the owning team in the author slot instead of the relay
 * pubkey that signed the event. The title stays on one line - a task title is
 * unbounded, and a wrapping caption reads like someone spoke it.
 *
 * Returns null for a malformed payload. A broken row is worth nothing on
 * screen, and rendering the raw JSON is the bug this replaces.
 */
export function TaskTransitionRow({
  className,
  message,
}: {
  className?: string;
  message: TimelineMessage;
}) {
  const payload = parseTaskTransitionPayload(message);
  if (!payload) return null;
  const described = describeTaskTransition(payload);
  if (!described) return null;

  return (
    <div
      className={cn(
        "mx-1 flex min-w-0 items-baseline gap-1.5 px-2 py-1",
        className,
      )}
      // Anchored scrolling finds thread rows by this attribute; a row without
      // one is invisible to the scroll restore even though it occupies height.
      data-message-id={message.id}
      data-testid="task-transition-row"
    >
      <span className="shrink-0 text-xs font-medium text-muted-foreground">
        {described.author}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground/80">
        {described.action}
      </span>
      <span className="shrink-0 text-2xs tabular-nums text-muted-foreground/55">
        {message.time}
      </span>
    </div>
  );
}
