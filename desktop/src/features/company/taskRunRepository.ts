import { relayClient } from "../../shared/api/relayClient.ts";
import type { RelaySubscriptionFilter } from "../../shared/api/relayClientShared.ts";
import type { RelayEvent } from "../../shared/api/types.ts";
import { KIND_JOB_HEAD } from "../../shared/constants/kinds.ts";

import {
  collapseAndSelectCurrentTaskRun,
  type TaskRunContext,
  type TaskRunHead,
} from "./taskRunContracts.ts";

let repositoryGeneration = 0;

export type TaskRunReadResult =
  | { ok: true; value: TaskRunHead | null }
  | { ok: false; code: "cancelled" | "unavailable"; message: string };

export type TaskRunRepositoryDependencies = {
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
};

/** Read the current durable run projection for one canonical task thread. */
export function createTaskRunRepository(
  dependencies: TaskRunRepositoryDependencies,
) {
  return {
    async getCurrentRun(context: TaskRunContext): Promise<TaskRunReadResult> {
      const generation = repositoryGeneration;
      let events: RelayEvent[];
      try {
        events = await dependencies.fetchEvents({
          kinds: [KIND_JOB_HEAD],
          "#task": [context.taskId],
          "#h": [context.channelId],
          "#e": [context.threadId],
          limit: 100,
        });
      } catch (error) {
        return {
          ok: false,
          code: "unavailable",
          message: `Task execution could not be read: ${String(error)}`,
        };
      }
      if (generation !== repositoryGeneration) {
        return {
          ok: false,
          code: "cancelled",
          message:
            "The Task execution read was cancelled because the active community changed.",
        };
      }
      return {
        ok: true,
        value: collapseAndSelectCurrentTaskRun(events, context),
      };
    },
  };
}

export type TaskRunRepository = ReturnType<typeof createTaskRunRepository>;

export const taskRunRepository = createTaskRunRepository({
  fetchEvents: (filter) => relayClient.fetchEvents(filter),
});

/** Invalidate reads crossing an active-community boundary. */
export function resetTaskRunRepositoryState(): void {
  repositoryGeneration += 1;
}
