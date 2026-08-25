import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import {
  bounceQueueTask,
  completeQueueTask,
  snoozeQueueTask,
} from "@/shared/api/taskTransition";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_TASK } from "@/shared/constants/kinds";

import { newestHead } from "./contracts";
import { companyActionBroker } from "./workRepository";
import type { CompanyActionBroker } from "./workRepository";

/**
 * The doer queue's three writes: complete with an outcome, snooze, bounce an
 * upstream task back for rework.
 *
 * Same shape as `startInitiative.ts` and `workContext.ts` - read the current
 * relay-signed head, ask the native backend to sign the one transition that
 * head permits, publish, and report what the broker's receipt said. Every
 * write is compare-and-set against the exact head just read, so a stale
 * click fails as a conflict rather than silently overwriting someone else's
 * change. The three signing calls are injected, same as `ensureTask` in
 * `workContext.ts`, so this module's own logic (fetch, publish, interpret
 * the receipt) is testable without a Tauri runtime.
 */

export type QueueActionOutcome =
  | { status: "applied" }
  | { status: "blocked"; message: string };

export type QueueActionDependencies = {
  relaySelf: () => Promise<string | null>;
  fetchTaskHead: (
    taskId: string,
    relaySelfPubkey: string,
  ) => Promise<RelayEvent | null>;
  signCompletion: typeof completeQueueTask;
  signSnooze: typeof snoozeQueueTask;
  signBounce: typeof bounceQueueTask;
  broker: Pick<CompanyActionBroker, "submit">;
};

async function defaultFetchTaskHead(
  taskId: string,
  relaySelfPubkey: string,
): Promise<RelayEvent | null> {
  const events = await relayClient.fetchEvents({
    kinds: [KIND_TASK],
    authors: [relaySelfPubkey],
    "#d": [taskId],
    limit: 8,
  });
  return newestHead(events);
}

function toOutcome(
  outcome: Awaited<ReturnType<CompanyActionBroker["submit"]>>,
): QueueActionOutcome {
  if (outcome.status === "applied") return { status: "applied" };
  return {
    status: "blocked",
    message:
      outcome.status === "no-receipt"
        ? outcome.message
        : `${outcome.message} Trying again is safe.`,
  };
}

export function createQueueActioner(dependencies: QueueActionDependencies) {
  async function withTaskHead(
    taskId: string,
  ): Promise<{ relayPubkey: string; taskHead: string }> {
    const relayPubkey = await dependencies.relaySelf();
    if (!relayPubkey) {
      throw new Error(
        "This community's relay has no stable identity, so this task cannot be changed.",
      );
    }
    const event = await dependencies.fetchTaskHead(taskId, relayPubkey);
    if (!event) {
      throw new Error("That task no longer exists on this community.");
    }
    return { relayPubkey, taskHead: JSON.stringify(event) };
  }

  return {
    async completeTask(
      taskId: string,
      outcomeReason: string,
    ): Promise<QueueActionOutcome> {
      const { relayPubkey, taskHead } = await withTaskHead(taskId);
      const signedAction = await dependencies.signCompletion({
        taskHead,
        outcomeReason,
        relayPubkey,
      });
      return toOutcome(await dependencies.broker.submit(signedAction));
    },
    async snoozeTask(
      taskId: string,
      wakeAt: number,
    ): Promise<QueueActionOutcome> {
      const { relayPubkey, taskHead } = await withTaskHead(taskId);
      const signedAction = await dependencies.signSnooze({
        taskHead,
        wakeAt,
        relayPubkey,
      });
      return toOutcome(await dependencies.broker.submit(signedAction));
    },
    async bounceUpstreamTask(
      upstreamTaskId: string,
      reason: string,
    ): Promise<QueueActionOutcome> {
      const { relayPubkey, taskHead } = await withTaskHead(upstreamTaskId);
      const signedAction = await dependencies.signBounce({
        upstreamTaskHead: taskHead,
        reason,
        relayPubkey,
      });
      return toOutcome(await dependencies.broker.submit(signedAction));
    },
  };
}

export type QueueActioner = ReturnType<typeof createQueueActioner>;

export const queueActioner = createQueueActioner({
  relaySelf: getRelaySelf,
  fetchTaskHead: defaultFetchTaskHead,
  signCompletion: completeQueueTask,
  signSnooze: snoozeQueueTask,
  signBounce: bounceQueueTask,
  broker: companyActionBroker,
});
