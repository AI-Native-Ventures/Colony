import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import type {
  ThreadAttachMode,
  ThreadAttachResult,
} from "@/shared/api/initiative";
import { attachThreadTask } from "@/shared/api/initiative";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_COMPANY_RECEIPT } from "@/shared/constants/kinds";

import { companyRepository } from "./companyRepository";
import type { CompanyTask } from "./contracts";
import { companyActionBroker, parseCompanyReceipt } from "./workRepository";
import type { CompanyActionBroker } from "./workRepository";

/**
 * The work an agent-directed message is charged to.
 *
 * A paid turn with no work context is money spent that no cost centre, team, or
 * commercial purpose can be traced to, and the classification cannot be
 * recovered afterwards. So the Task is confirmed by the relay *before* the
 * instruction is sent, and the message carries references to the canonical
 * record rather than to what this client hoped it would be.
 *
 * Which Task that is, is the relay's decision, not this client's. A thread
 * holds at most one open Task, and two devices preparing the same send would
 * each read "no open task" and each open one. So nothing here proposes a task
 * id: it asks, publishes the question, and reads the answer out of the
 * receipt.
 *
 * Only three references go on the message. Cost centre, client, commercial
 * purpose, and accounting classification are deliberately absent: they are
 * properties of the Task, and a prompt that carried them would be a prompt that
 * could lie about them.
 */

export type WorkContextTags = string[][];

export type ResolvedWorkContext = {
  taskId: string;
  initiativeId: string | null;
  owningTeamId: string;
  /** Whether the turn was charged to the thread's hidden chat task. */
  hidden: boolean;
  tags: WorkContextTags;
};

export type WorkContextRequest = {
  channelId: string;
  /** This client's stable identity for this send. A retry reuses it. */
  sendId: string;
  /** The agent this send names, `null` when it names none. */
  agentPubkey: string | null;
  /** The instruction being sent, used as the Task title when one is opened. */
  title: string;
  /** What this send asks its thread for. */
  mode: ThreadAttachMode;
  clientOrganizationId?: string | null;
  /**
   * Root event id of the thread this send replies in, absent at channel root.
   * A send that starts its own thread is claimed under its send id instead,
   * and the relay rebinds that claim onto the real root when the message
   * arrives, so the first reply does not read as a brand-new thread.
   */
  threadRoot?: string | null;
  /** True in a DM, where the conversation itself is the thread. */
  conversationScope?: boolean;
};

export type WorkContextDependencies = {
  relaySelf: () => Promise<string | null>;
  attach: (input: {
    channelId: string;
    sendId: string;
    agentPubkey: string | null;
    title: string;
    mode: ThreadAttachMode;
    threadRoot: string | null;
    conversationScope: boolean;
    clientOrganizationId: string | null;
    relayPubkey: string;
  }) => Promise<ThreadAttachResult>;
  broker: Pick<CompanyActionBroker, "submit">;
  /** The head one already-applied company action produced, from its receipt. */
  headForAction: (actionEventId: string) => Promise<string | null>;
  loadTask: (
    headEventId: string,
  ) => ReturnType<typeof companyRepository.getTaskByHeadEvent>;
};

/**
 * The exact reference tags a canonical Task contributes to a message.
 *
 * Built from the relay-authored head, never from the request: the head is what
 * the ACP harness will re-read, and a message that disagreed with it would
 * attribute a turn to work the relay never recorded.
 */
export function workContextTags(task: CompanyTask): WorkContextTags {
  const tags: WorkContextTags = [["task", task.id]];
  if (task.initiativeId) tags.push(["initiative", task.initiativeId]);
  tags.push(["team", task.owningTeamId]);
  return tags;
}

/** Merge work context into outgoing tags, refusing to duplicate any of them. */
export function mergeWorkContextTags(
  outgoing: readonly string[][],
  context: WorkContextTags,
): string[][] {
  const reserved = new Set(["task", "initiative", "team"]);
  const kept = outgoing.filter((tag) => !reserved.has(tag[0] ?? ""));
  return [...kept, ...context];
}

export function createWorkContextResolver(
  dependencies: WorkContextDependencies,
) {
  return async function resolve(
    request: WorkContextRequest,
  ): Promise<ResolvedWorkContext> {
    const relayPubkey = await dependencies.relaySelf();
    if (!relayPubkey) {
      throw new Error(
        "This community's relay has no stable identity, so agent work cannot be recorded against it.",
      );
    }

    const planned = await dependencies.attach({
      channelId: request.channelId,
      sendId: request.sendId,
      agentPubkey: request.agentPubkey,
      title: request.title,
      mode: request.mode,
      threadRoot: request.threadRoot ?? null,
      conversationScope: request.conversationScope ?? false,
      clientOrganizationId: request.clientOrganizationId ?? null,
      relayPubkey,
    });

    const outcome = await dependencies.broker.submit(planned.signedAction);
    // An applied receipt names the Task head this send resolved to, including
    // when the relay attached to a Task that already existed: rewriting that
    // head to say the same thing would churn a record nobody asked to change,
    // so the receipt points at the head that is already stored.
    //
    // A superseded submission means an earlier attempt at this exact send
    // already won the idempotency claim. That is the same goal state reached a
    // different way, and the winning action's own receipt names the Task it
    // was answered with. Anything else has not been recorded, and sending the
    // instruction anyway would buy an agent turn nothing can account for.
    let headEventId: string | null = null;
    if (outcome.status === "applied") {
      headEventId = outcome.headEventId;
    } else if (outcome.status === "superseded") {
      headEventId = await dependencies.headForAction(outcome.winnerEventId);
    } else {
      throw new Error(`${outcome.message} The message has not been sent.`);
    }

    if (!headEventId) {
      throw new Error(
        "The relay did not say which task this message belongs to, so it has not been sent. Trying again is safe.",
      );
    }

    const task = await dependencies.loadTask(headEventId);
    if (!task.ok) {
      throw new Error(
        "The work record for this message could not be read back, so the message has not been sent. Trying again is safe.",
      );
    }

    return {
      taskId: task.value.id,
      initiativeId: task.value.initiativeId,
      owningTeamId: task.value.owningTeamId,
      hidden: task.value.hidden,
      tags: workContextTags(task.value),
    };
  };
}

/**
 * The head event one applied company action produced.
 *
 * Only used for the superseded path, where this client holds the winning
 * action's id but never saw its receipt.
 */
async function headForAction(actionEventId: string): Promise<string | null> {
  const relaySelfPubkey = await getRelaySelf();
  if (!relaySelfPubkey) return null;
  const candidate: RelayEvent | null = await relayClient.fetchFirstEvent({
    kinds: [KIND_COMPANY_RECEIPT],
    authors: [relaySelfPubkey],
    "#e": [actionEventId],
    limit: 1,
  });
  if (!candidate) return null;
  const receipt = parseCompanyReceipt(
    candidate,
    relaySelfPubkey,
    actionEventId,
  );
  return receipt?.outcome === "applied" ? receipt.headEventId : null;
}

export const resolveWorkContext = createWorkContextResolver({
  relaySelf: getRelaySelf,
  attach: attachThreadTask,
  broker: companyActionBroker,
  headForAction,
  loadTask: (headEventId) => companyRepository.getTaskByHeadEvent(headEventId),
});
