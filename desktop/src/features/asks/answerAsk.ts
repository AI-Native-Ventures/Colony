import type { OpenAsk } from "./lib/askEvent";
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

/** Publish the canonical answer that closes one open ask. */
export async function answerAsk(
  ask: OpenAsk,
  decision: string,
  rationale: string,
  dependencies: AnswerAskDependencies,
): Promise<void> {
  const event = await dependencies.signRelayEvent({
    kind: KIND_ASK_RESOLUTION,
    content: JSON.stringify({ answer: { decision, rationale } }),
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
  ]);
}
