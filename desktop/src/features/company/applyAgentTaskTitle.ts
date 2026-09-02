/**
 * Applying the name an agent gave its own work.
 *
 * Same shape as `createTask.ts`: the desktop never signs a company head
 * itself, it asks the backend what to publish and waits for the relay's
 * receipt. Split from `agentTaskTitle.ts` so the decision stays pure and this
 * file owns the writes.
 */
import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import { renameTaskFromAgent } from "@/shared/api/taskTransition";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_TASK } from "@/shared/constants/kinds";

import { agentTitleForTask } from "./agentTaskTitle";
import type { CompanyTask } from "./contracts";
import { newestHead } from "./contracts";
import { companyActionBroker } from "./workRepository";
import type { CompanyActionBroker } from "./workRepository";

export type ApplyAgentTitleRequest = {
  task: CompanyTask;
  /** The instruction the task was minted from, from its run. */
  instruction: string | null;
  /** The agent's latest checkpoint summary, if it has written one. */
  checkpointSummary: string | null;
};

export type ApplyAgentTitleOutcome =
  | { status: "renamed"; title: string }
  | { status: "skipped" }
  | { status: "failed"; message: string };

export type ApplyAgentTitleDependencies = {
  relaySelf: () => Promise<string | null>;
  fetchTaskHead: (
    taskId: string,
    relaySelfPubkey: string,
  ) => Promise<RelayEvent | null>;
  sign: typeof renameTaskFromAgent;
  broker: Pick<CompanyActionBroker, "submit">;
};

export function createAgentTitleApplier(
  dependencies: ApplyAgentTitleDependencies,
) {
  return async function apply(
    request: ApplyAgentTitleRequest,
  ): Promise<ApplyAgentTitleOutcome> {
    const title = agentTitleForTask({
      task: request.task,
      instruction: request.instruction,
      checkpointSummary: request.checkpointSummary,
    });
    // The common answer. Not a failure: the task was hand-named, the agent
    // has not checkpointed, or its summary is prose rather than a name.
    if (!title) return { status: "skipped" };

    const relayPubkey = await dependencies.relaySelf();
    if (!relayPubkey) return { status: "skipped" };

    // Pinned to the head this rename was planned against, so a task that
    // moved underneath loses the compare-and-set rather than overwriting it.
    const head = await dependencies.fetchTaskHead(request.task.id, relayPubkey);
    if (!head) return { status: "skipped" };

    let signed: string;
    try {
      signed = await dependencies.sign({
        taskHead: JSON.stringify(head),
        title,
        relayPubkey,
      });
    } catch (error) {
      return {
        status: "failed",
        message: error instanceof Error ? error.message : "could not sign",
      };
    }

    const outcome = await dependencies.broker.submit(signed);
    // A conflict means the head moved: another rename won, or the task
    // transitioned. Either way this title is stale and must not be retried
    // against a head it was not planned for.
    if (outcome.status !== "applied") {
      return outcome.status === "conflict"
        ? { status: "skipped" }
        : { status: "failed", message: outcome.message };
    }
    return { status: "renamed", title };
  };
}

export const applyAgentTaskTitle = createAgentTitleApplier({
  relaySelf: getRelaySelf,
  fetchTaskHead: async (taskId, relaySelfPubkey) =>
    newestHead(
      await relayClient.fetchEvents({
        kinds: [KIND_TASK],
        authors: [relaySelfPubkey],
        "#d": [taskId],
        limit: 8,
      }),
    ),
  sign: renameTaskFromAgent,
  broker: companyActionBroker,
});
