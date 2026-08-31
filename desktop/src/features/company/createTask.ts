import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import type { UserTaskResult } from "@/shared/api/initiative";
import { createUserTask } from "@/shared/api/initiative";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_COMPANY_PROFILE } from "@/shared/constants/kinds";

import { companyRepository } from "./companyRepository";
import type { CompanyTask } from "./contracts";
import { COMMUNITY_PROFILE_ID, newestHead } from "./contracts";
import { validateNewTaskInput } from "./newTaskModel";
import { companyActionBroker } from "./workRepository";
import type { CompanyActionBroker } from "./workRepository";

/**
 * Creating a Task by hand from a "New task" affordance, rather than one a
 * chat send or an initiative kickoff creates implicitly.
 *
 * Same shape as `resolveWorkContext` in workContext.ts: the desktop never
 * signs a company head, it only asks the backend what to publish and then
 * waits for the relay's own receipt before treating anything as created.
 */

export type CreateTaskRequest = {
  channelId: string;
  title: string;
  /** The single persona accountable for the work. */
  assigneePersonaId: string;
  /** Personas mentioned alongside the assignee. Not accountable. */
  watcherPersonaIds?: readonly string[];
  /**
   * This client's stable identity for this create attempt. A retry (a lost
   * receipt, resubmitting after a failure) reuses it; a fresh "create" click
   * mints a new one - reusing one across two different attempts would ask
   * the backend to update the first Task instead of creating a second.
   */
  requestId: string;
};

export type CreateTaskDependencies = {
  relaySelf: () => Promise<string | null>;
  fetchCompanyHead: (relaySelfPubkey: string) => Promise<RelayEvent | null>;
  createUserTask: (input: {
    companyHead: string;
    requestId: string;
    channelId: string;
    title: string;
    assigneePersonaIds: string[];
    relayPubkey: string;
  }) => Promise<UserTaskResult>;
  broker: Pick<CompanyActionBroker, "submit">;
  loadTask: (taskId: string) => ReturnType<typeof companyRepository.getTask>;
};

export function createTaskCreator(dependencies: CreateTaskDependencies) {
  return async function run(request: CreateTaskRequest): Promise<CompanyTask> {
    const validation = validateNewTaskInput(request);
    if (!validation.ok) {
      throw new Error(validation.message);
    }

    const relayPubkey = await dependencies.relaySelf();
    if (!relayPubkey) {
      throw new Error(
        "This community's relay has no stable identity, so this task cannot be recorded against it.",
      );
    }

    const companyEvent = await dependencies.fetchCompanyHead(relayPubkey);
    if (!companyEvent) {
      throw new Error(
        "This community has not described its business yet, so this task has no cost centre to charge.",
      );
    }

    const planned = await dependencies.createUserTask({
      companyHead: JSON.stringify(companyEvent),
      requestId: request.requestId,
      channelId: request.channelId,
      title: validation.title,
      // One accountable persona. Watchers are mentioned on the kickoff
      // message instead: an assignee list of several says several people own
      // the task, which is the state this form exists to prevent.
      assigneePersonaIds: [validation.assigneePersonaId],
      relayPubkey,
    });

    const outcome = await dependencies.broker.submit(planned.signedAction);
    // A conflict here means a Task with this request id already exists,
    // which is the state a retry was trying to reach - the same treatment
    // resolveWorkContext gives ensure_chat_task's outcome.
    if (outcome.status !== "applied" && outcome.status !== "conflict") {
      throw new Error(outcome.message);
    }

    const task = await dependencies.loadTask(planned.taskId);
    if (!task.ok) {
      throw new Error(
        "The task was recorded but could not be read back. Trying again is safe.",
      );
    }
    return task.value;
  };
}

export const createTaskFromForm = createTaskCreator({
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
  createUserTask,
  broker: companyActionBroker,
  loadTask: (taskId) => companyRepository.getTask(taskId),
});
