import type { OpenAsk } from "@/features/asks/lib/askEvent";

/**
 * Which delivery channel an answer takes (spec: "Answering: the reply goes
 * where the question lives").
 *
 * - `thread-reply`: an ordinary stream message into the ask's origin
 *   thread. The relay's `try_auto_resolve_from_reply` closes the ask from
 *   that reply alone; the client never publishes a resolution card here.
 * - `resolution-card`: the only delivery channel when there is no origin
 *   thread to reply into — the kind 44301 card via `features/asks/answerAsk.ts`.
 *
 * A thread ping (spec: same composer, posts into the ping's thread,
 * p-tagging the asker) is a different item kind entirely and is not
 * represented here yet — ping detection is a separate ticket
 * (thread-ping-lane) and out of scope until it lands.
 */
export type AskAnswerRoute =
  | { kind: "thread-reply"; channelId: string; threadId: string }
  | { kind: "resolution-card" };

/**
 * Route an ask's answer by whether it carries an origin thread (`e` tag).
 * Mirrors the ticket's own routing rule exactly: threaded when both
 * `channelId` and `threadId` are present, thread-less otherwise.
 */
export function resolveAskAnswerRoute(
  ask: Pick<OpenAsk, "channelId" | "threadId">,
): AskAnswerRoute {
  if (ask.channelId && ask.threadId) {
    return {
      kind: "thread-reply",
      channelId: ask.channelId,
      threadId: ask.threadId,
    };
  }
  return { kind: "resolution-card" };
}
