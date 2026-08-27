import type { OpenAsk } from "./lib/askEvent";
import { buildAskAnswer } from "./lib/askOptions";
import { KIND_ASK_RESOLUTION } from "@/shared/constants/kinds";
import type { RelayEvent } from "@/shared/api/types";

export type AnswerAskDependencies = {
  signRelayEvent: (input: {
    kind: number;
    content: string;
    tags: string[][];
  }) => Promise<RelayEvent>;
  publishEvent: (
    event: RelayEvent,
    timeoutMessage: string,
    sendErrorMessage: string,
  ) => Promise<unknown>;
  invalidateQueries: (queryKey: readonly unknown[]) => Promise<unknown>;
};

/**
 * What the owner answered: a chosen option label when the ask offered
 * options, free text when it did not, and an optional rationale either way.
 */
export type AskAnswerInput = {
  decision: string;
  rationale: string;
  /** The `options[].label` picked, or null on a free-text answer. */
  optionLabel: string | null;
};

/** Publish the canonical answer that closes one open ask. */
export async function answerAsk(
  ask: OpenAsk,
  answer: AskAnswerInput,
  dependencies: AnswerAskDependencies,
): Promise<void> {
  const event = await dependencies.signRelayEvent({
    kind: KIND_ASK_RESOLUTION,
    // `default_executed` is deliberately absent: only the relay may claim a
    // stated default fired, and `parse_resolution` defaults it to false.
    content: JSON.stringify({ answer: buildAskAnswer(answer) }),
    tags: [["e", ask.id]],
  });
  await dependencies.publishEvent(
    event,
    "Timed out answering the ask.",
    "Failed to answer the ask.",
  );
  await Promise.all([
    dependencies.invalidateQueries(["open-asks"]),
    dependencies.invalidateQueries(["open-ask-closures"]),
    // The relay closes this ask's state head on resolution, so the countdown
    // surfaces must re-read it rather than keep ticking toward a deadline
    // that can no longer fire.
    dependencies.invalidateQueries(["ask-states"]),
  ]);
}
