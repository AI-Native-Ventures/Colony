import { invokeTauri } from "./tauri";

/**
 * A doer's queue decision: complete, snooze, or bounce.
 *
 * Mirrors `initiative.ts` - the backend holds the owner's signing key and
 * the rule for what may be published; this asks it to sign one specific
 * task transition and hands back the Company Action to publish. The caller
 * still owns publishing it through `companyActionBroker` and reading the
 * receipt.
 */

export async function completeQueueTask(input: {
  taskHead: string;
  outcomeReason: string;
  relayPubkey: string;
}): Promise<string> {
  return await invokeTauri<string>("complete_queue_task", {
    taskHead: input.taskHead,
    outcomeReason: input.outcomeReason,
    relayPubkey: input.relayPubkey,
  });
}

/**
 * Rename a chat-attributed task to the name its agent gave the work.
 *
 * Owner-signed in the backend: KIND_COMPANY_ACTION is owner-only, and the
 * agent that wrote the name holds MessagesWrite.
 */
export async function renameTaskFromAgent(input: {
  taskHead: string;
  title: string;
  relayPubkey: string;
}): Promise<string> {
  return await invokeTauri<string>("rename_task_from_agent", {
    taskHead: input.taskHead,
    title: input.title,
    relayPubkey: input.relayPubkey,
  });
}

export async function snoozeQueueTask(input: {
  taskHead: string;
  wakeAt: number;
  relayPubkey: string;
}): Promise<string> {
  return await invokeTauri<string>("snooze_queue_task", {
    taskHead: input.taskHead,
    wakeAt: input.wakeAt,
    relayPubkey: input.relayPubkey,
  });
}

export async function bounceQueueTask(input: {
  upstreamTaskHead: string;
  reason: string;
  relayPubkey: string;
}): Promise<string> {
  return await invokeTauri<string>("bounce_queue_task", {
    upstreamTaskHead: input.upstreamTaskHead,
    reason: input.reason,
    relayPubkey: input.relayPubkey,
  });
}
