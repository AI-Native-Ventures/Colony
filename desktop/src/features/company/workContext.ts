import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import type { ChatTaskResult } from "@/shared/api/initiative";
import { ensureChatTask } from "@/shared/api/initiative";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_COMPANY_PROFILE } from "@/shared/constants/kinds";

import { companyRepository } from "./companyRepository";
import type { CompanyTask } from "./contracts";
import { COMMUNITY_PROFILE_ID, newestHead } from "./contracts";
import { companyActionBroker } from "./workRepository";
import type { CompanyActionBroker } from "./workRepository";

/**
 * The work an agent-directed message is charged to.
 *
 * A paid turn with no work context is money spent that no cost centre, team, or
 * commercial purpose can be traced to, and the classification cannot be
 * recovered afterwards. So the Task is created and confirmed by the relay
 * *before* the instruction is sent, and the message carries references to the
 * canonical record rather than to what this client hoped it would be.
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
  tags: WorkContextTags;
};

export type WorkContextRequest = {
  channelId: string;
  /** This client's stable identity for this send. A retry reuses it. */
  sendId: string;
  agentPubkey: string;
  /** The instruction being sent, used as the Task title. */
  title: string;
  clientOrganizationId?: string | null;
};

export type WorkContextDependencies = {
  relaySelf: () => Promise<string | null>;
  fetchCompanyHead: (relaySelfPubkey: string) => Promise<RelayEvent | null>;
  ensureTask: (input: {
    companyHead: string;
    channelId: string;
    sendId: string;
    agentPubkey: string;
    title: string;
    clientOrganizationId: string | null;
    relayPubkey: string;
  }) => Promise<ChatTaskResult>;
  broker: Pick<CompanyActionBroker, "submit">;
  loadTask: (taskId: string) => ReturnType<typeof companyRepository.getTask>;
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
    const companyEvent = await dependencies.fetchCompanyHead(relayPubkey);
    if (!companyEvent) {
      throw new Error(
        "This community has not described its business yet, so this work has no cost centre to charge.",
      );
    }

    const planned = await dependencies.ensureTask({
      companyHead: JSON.stringify(companyEvent),
      channelId: request.channelId,
      sendId: request.sendId,
      agentPubkey: request.agentPubkey,
      title: request.title,
      clientOrganizationId: request.clientOrganizationId ?? null,
      relayPubkey,
    });

    const outcome = await dependencies.broker.submit(planned.signedAction);
    // A conflict here means the Task already exists, which is the state this
    // was trying to reach. Anything else has not been recorded, and sending
    // the instruction anyway would buy an agent turn nothing can account for.
    if (outcome.status !== "applied" && outcome.status !== "conflict") {
      throw new Error(
        outcome.status === "no-receipt"
          ? `${outcome.message} The message has not been sent.`
          : `${outcome.message} The message has not been sent.`,
      );
    }

    const task = await dependencies.loadTask(planned.taskId);
    if (!task.ok) {
      throw new Error(
        "The work record for this message could not be read back, so the message has not been sent. Trying again is safe.",
      );
    }

    return {
      taskId: task.value.id,
      initiativeId: task.value.initiativeId,
      owningTeamId: task.value.owningTeamId,
      tags: workContextTags(task.value),
    };
  };
}

export const resolveWorkContext = createWorkContextResolver({
  relaySelf: getRelaySelf,
  fetchCompanyHead: async (relaySelfPubkey) =>
    newestHead(
      await relayClient.fetchEvents({
        kinds: [KIND_COMPANY_PROFILE],
        authors: [relaySelfPubkey],
        "#d": [COMMUNITY_PROFILE_ID],
        limit: 8,
      }),
    ),
  ensureTask: ensureChatTask,
  broker: companyActionBroker,
  loadTask: (taskId) => companyRepository.getTask(taskId),
});
