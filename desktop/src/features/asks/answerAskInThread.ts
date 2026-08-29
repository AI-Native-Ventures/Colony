import type { OpenAsk } from "./lib/askEvent";
import { effectiveFilerPubkey } from "./lib/askRouting";
import type { SendChannelMessageResult } from "@/shared/api/types";

export type AnswerAskInThreadDependencies = {
  sendChannelMessage: (input: {
    channelId: string;
    content: string;
    parentEventId: string;
    mentionPubkeys: string[];
  }) => Promise<SendChannelMessageResult>;
  invalidateQueries: (queryKey: readonly unknown[]) => Promise<unknown>;
};

export type AskThreadAnswerInput = {
  decision: string;
  rationale: string;
};

/**
 * The plain-text body an in-thread answer posts. No JSON, no protocol
 * vocabulary: this is an ordinary message a human or agent reading the
 * thread later reads like any other reply.
 */
export function buildThreadAnswerContent(input: AskThreadAnswerInput): string {
  const decision = input.decision.trim();
  const rationale = input.rationale.trim();
  return rationale === "" ? decision : `${decision}\n\n${rationale}`;
}

/**
 * Answer an ask by replying in its origin thread, instead of publishing a
 * kind 44301 resolution card.
 *
 * The relay's `try_auto_resolve_from_reply` (`buzz-relay/src/ask_broker.rs`)
 * does the actual closing: it fires on an ordinary kind 9/40002 message
 * whose NIP-10 thread root matches the ask's `origin_thread`, signed by a
 * current owner, for every open ask bound to that root whose own audience
 * is also a current owner — no resolution-card event of any kind is
 * involved, and none is published here.
 *
 * Mentioning the filer here is NOT what makes auto-resolve fire (it matches
 * on thread root alone, regardless of who is p-tagged). It is a fallback:
 * the relay's own wake-up receipt is refused if the ask's thread lives in a
 * channel the filer cannot legitimately post in (`emit_ask_receipt`'s
 * `legitimate` check), and mentioning the filer directly, in the owner's
 * own message, is the only wake-up that survives that case.
 */
export async function answerAskInThread(
  ask: OpenAsk & { channelId: string; threadId: string },
  answer: AskThreadAnswerInput,
  dependencies: AnswerAskInThreadDependencies,
): Promise<void> {
  await dependencies.sendChannelMessage({
    channelId: ask.channelId,
    content: buildThreadAnswerContent(answer),
    parentEventId: ask.threadId,
    mentionPubkeys: [effectiveFilerPubkey(ask)],
  });
  await Promise.all([
    dependencies.invalidateQueries(["open-asks"]),
    dependencies.invalidateQueries(["open-ask-closures"]),
    dependencies.invalidateQueries(["ask-states"]),
  ]);
}
