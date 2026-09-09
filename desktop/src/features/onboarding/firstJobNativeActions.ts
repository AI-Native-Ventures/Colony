import { companyRepository } from "@/features/company/companyRepository";
import {
  isTerminalTaskStatus,
  type CompanyParseResult,
  type CompanyTask,
} from "@/features/company/contracts";
import { workContextTags } from "@/features/company/workContext";
import { createCompanyActionBroker } from "@/features/company/workRepository";
import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { attachThreadTask } from "@/shared/api/initiative";
import { relayClient } from "@/shared/api/relayClient";
import { listManagedAgents, signRelayEvent } from "@/shared/api/tauri";
import { canonicalRelayUrl } from "@/features/agents/managedAgentRuntimeStatus";
import type { ManagedAgent, RelayEvent } from "@/shared/api/types";
import { KIND_COMPANY_RECEIPT } from "@/shared/constants/kinds";
import type {
  FirstJobDispatchDependencies,
  FirstJobWork,
} from "./firstJobDispatch";
import { assertFirstJobScope } from "./firstJobScope";
import type { FirstJobScope, FirstJobTeam } from "./firstJobStart";
import {
  readFirstJobTaskReceipt,
  resolveFirstJobTaskHead,
} from "./firstJobTaskReceipt";
import {
  firstJobDispatchBinding,
  firstJobInstruction,
} from "./firstJobMessage";

async function current<T>(
  scope: FirstJobScope,
  operation: () => Promise<T>,
): Promise<T> {
  await assertFirstJobScope(scope);
  const result = await operation();
  await assertFirstJobScope(scope);
  return result;
}

/** Tasks need the community's approved setup, including its internal work budget. */
export async function checkFirstJobBusiness(
  scope: FirstJobScope,
): Promise<string | null> {
  const profile = await current(scope, () =>
    companyRepository.getActiveCompany(),
  );
  if (!profile.ok) {
    if (profile.code === "missing-head")
      return "Colony could not find this business’s setup on the server. This is a workspace setup problem, not an approval you missed. Your brief is saved; try again after the workspace connection is repaired.";
    throw new Error("Your business setup could not be checked. Try again.");
  }
  if (!profile.value.costCentres.some((centre) => centre.kind === "internal"))
    return "Your business setup is missing a budget for internal work. Review the setup with your Chief of Staff, then try again.";
  return null;
}

async function resolveFirstJobWork(
  scope: FirstJobScope,
  action: RelayEvent,
  team: FirstJobTeam,
): Promise<FirstJobWork> {
  const relayPubkey = await current(scope, getRelaySelf);
  if (!relayPubkey)
    throw new Error(
      "The business connection is not ready to record this job. Try again.",
    );
  const readReceipt = async () => {
    const event = await current(scope, () =>
      relayClient.fetchFirstEvent({
        kinds: [KIND_COMPANY_RECEIPT],
        authors: [relayPubkey],
        "#e": [action.id],
        limit: 1,
      }),
    );
    return readFirstJobTaskReceipt(action, event, relayPubkey);
  };
  const broker = createCompanyActionBroker({
    relaySelf: () => current(scope, async () => relayPubkey),
    publish: (event) =>
      current(scope, () =>
        relayClient.publishEvent(
          event,
          "The job's task receipt has not arrived. Retry this saved request.",
          "The task for this job could not be recorded.",
          scope.relayUrl,
        ),
      ),
    fetchFirstEvent: (filter) =>
      current(scope, () => relayClient.fetchFirstEvent(filter)),
  });
  const headEventId = await resolveFirstJobTaskHead(action.id, {
    readReceipt,
    submit: () => broker.submit(JSON.stringify(action)),
  });
  await assertFirstJobScope(scope);
  const result = await current(scope, () =>
    companyRepository.getTaskByHeadEvent(headEventId),
  );
  if (
    !result.ok ||
    result.value.sourceChannelId !== scope.channelId ||
    result.value.threadRoot !== scope.threadRootId ||
    result.value.hidden
  ) {
    throw new Error(
      "The task for this thread could not be confirmed. The instruction has not been sent.",
    );
  }
  const agents = await current(scope, listManagedAgents);
  const scout = agents.find(
    (agent) =>
      agent.pubkey === team.scoutPubkey &&
      canonicalRelayUrl(agent.relayUrl) === canonicalRelayUrl(scope.relayUrl),
  );
  if (
    !scout?.personaId ||
    !result.value.assigneePersonaIds.includes(scout.personaId)
  )
    throw new Error(
      "This task is not assigned to your Chief of Staff. Review this thread before continuing; no instruction has been sent.",
    );
  return {
    actionId: action.id,
    taskId: result.value.id,
    tags: workContextTags(result.value),
    createdAt: action.created_at,
  };
}

/** Read the latest task, rather than treating an old creation receipt as live approval. */
export function createFirstJobWorkValidator(deps: {
  assertCurrent(scope: FirstJobScope): Promise<void>;
  loadTask(taskId: string): Promise<CompanyParseResult<CompanyTask>>;
  listAgents(): Promise<
    Pick<ManagedAgent, "pubkey" | "relayUrl" | "personaId">[]
  >;
}) {
  return async (
    scope: FirstJobScope,
    team: FirstJobTeam,
    work: FirstJobWork,
  ): Promise<void> => {
    await deps.assertCurrent(scope);
    const result = await deps.loadTask(work.taskId);
    await deps.assertCurrent(scope);
    if (!result.ok)
      throw new Error(
        "The current task could not be checked. No instruction has been sent; try again.",
      );
    const task = result.value;
    if (
      task.id !== work.taskId ||
      task.hidden ||
      isTerminalTaskStatus(task.status) ||
      task.threadRoot !== scope.threadRootId ||
      task.sourceChannelId !== scope.channelId ||
      JSON.stringify(workContextTags(task)) !== JSON.stringify(work.tags)
    )
      throw new Error(
        "This task has changed or is already closed. Review the task in this thread before continuing; no instruction has been sent.",
      );
    const agents = await deps.listAgents();
    await deps.assertCurrent(scope);
    const scout = agents.find(
      (agent) =>
        agent.pubkey === team.scoutPubkey &&
        canonicalRelayUrl(agent.relayUrl) === canonicalRelayUrl(scope.relayUrl),
    );
    if (!scout?.personaId || !task.assigneePersonaIds.includes(scout.personaId))
      throw new Error(
        "This task is no longer assigned to your Chief of Staff. Review the task in this thread; no instruction has been sent.",
      );
  };
}

/** Snapshot the selected worker's readable name immediately before native signing. */
export function createFirstJobMessagePreparer(deps: {
  assertCurrent(scope: FirstJobScope): Promise<void>;
  listAgents(): Promise<Pick<ManagedAgent, "pubkey" | "relayUrl" | "name">[]>;
  signMessage: typeof signRelayEvent;
}): FirstJobDispatchDependencies["prepareMessage"] {
  return async ({ scope, content, team, work }) => {
    await deps.assertCurrent(scope);
    const agents = await deps.listAgents();
    await deps.assertCurrent(scope);
    const worker = agents.find(
      (agent) =>
        agent.pubkey === team.workerPubkey &&
        canonicalRelayUrl(agent.relayUrl) === canonicalRelayUrl(scope.relayUrl),
    );
    const message = await deps.signMessage({
      kind: 9,
      content: firstJobInstruction(content, worker?.name),
      createdAt: Math.max(work.createdAt, Math.floor(Date.now() / 1000)),
      tags: [
        ["h", scope.channelId],
        ["e", scope.threadRootId, "", "reply"],
        ["p", team.scoutPubkey],
        ["mention", team.workerPubkey],
        ["client", "colony:first-job-start:v1", scope.requestId],
        ...work.tags,
      ],
    });
    await deps.assertCurrent(scope);
    return message;
  };
}

/** Existing native signing and relay-authoritative Task APIs, captured to one job. */
export const firstJobNativeActions: Pick<
  FirstJobDispatchDependencies,
  "plan" | "resolveWork" | "validateWork" | "prepareMessage" | "publish"
> = {
  async plan({ scope, content, team, revision, nonce }) {
    const businessBlock = await checkFirstJobBusiness(scope);
    if (businessBlock) throw new Error(businessBlock);
    const binding = await firstJobDispatchBinding(
      scope,
      content,
      team,
      revision ?? 0,
      nonce,
    );
    const relayPubkey = await current(scope, getRelaySelf);
    if (!relayPubkey)
      throw new Error(
        "The business connection is not ready to record this job. Try again.",
      );
    const planned = await current(scope, () =>
      attachThreadTask({
        channelId: scope.channelId,
        sendId: scope.requestId,
        agentPubkey: team.scoutPubkey,
        title: content,
        mode: "open",
        threadRoot: scope.threadRootId,
        conversationScope: false,
        relayPubkey,
        dispatchBinding: binding,
        expectedOwnerPubkey: scope.ownerPubkey,
        expectedRelayUrl: scope.relayUrl,
      }),
    );
    const event = JSON.parse(planned.signedAction) as RelayEvent;
    if (event.pubkey !== scope.ownerPubkey)
      throw new Error("The account changed before this job could start.");
    return event;
  },
  resolveWork: resolveFirstJobWork,
  validateWork: createFirstJobWorkValidator({
    assertCurrent: assertFirstJobScope,
    loadTask: (taskId) => companyRepository.getTask(taskId),
    listAgents: listManagedAgents,
  }),
  prepareMessage: createFirstJobMessagePreparer({
    assertCurrent: assertFirstJobScope,
    listAgents: listManagedAgents,
    signMessage: signRelayEvent,
  }),
  async publish(scope, event) {
    await current(scope, () =>
      relayClient.publishEvent(
        event,
        "The job request has not been confirmed. Retry uses the same saved instruction.",
        "The job request could not be sent. Retry this saved instruction.",
        scope.relayUrl,
      ),
    );
  },
};
