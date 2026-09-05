import { useQuery } from "@tanstack/react-query";

import type { ChannelType } from "@/shared/api/types";

import { companyRepository } from "./companyRepository";
import type { TaskQuery } from "./companyRepository";
import type { CompanyParseResult } from "./contracts";
import { isTerminalTaskStatus } from "./contracts";

/**
 * React Query access to a community's company records.
 *
 * Every key starts with the community ID. Switching community remounts the
 * subtree but the query cache survives, so a key that omitted it would serve
 * the previous community's initiatives to the next one.
 */

const COMPANY_ROOT = "colony-company" as const;

/** Key for the active company profile in one community. */
export function activeCompanyQueryKey(communityId: string) {
  return [COMPANY_ROOT, communityId, "active-profile"] as const;
}

export function initiativesQueryKey(communityId: string) {
  return [COMPANY_ROOT, communityId, "initiatives"] as const;
}

export function initiativeQueryKey(communityId: string, initiativeId: string) {
  return [COMPANY_ROOT, communityId, "initiative", initiativeId] as const;
}

export function cohortsQueryKey(communityId: string) {
  return [COMPANY_ROOT, communityId, "cohorts"] as const;
}

export function tasksQueryKey(communityId: string, scope: TaskQuery) {
  return [
    COMPANY_ROOT,
    communityId,
    "tasks",
    scope.initiativeId ?? "",
    scope.status ?? "",
    scope.teamId ?? "",
    scope.stage ?? "",
    scope.subject ? `${scope.subject.kind}:${scope.subject.ref}` : "",
  ] as const;
}

export function taskQueryKey(communityId: string, taskId: string) {
  return [COMPANY_ROOT, communityId, "task", taskId] as const;
}

export function threadTasksQueryKey(communityId: string, threadRoot: string) {
  return [COMPANY_ROOT, communityId, "thread-tasks", threadRoot] as const;
}

export function conversationTasksQueryKey(
  communityId: string,
  channelId: string,
) {
  return [COMPANY_ROOT, communityId, "conversation-tasks", channelId] as const;
}

/**
 * A transport failure is thrown so React Query retries it; a refusal
 * ("no company here yet") is data and must not be retried forever.
 */
function requireAvailable<T>(
  result: CompanyParseResult<T>,
): CompanyParseResult<T> {
  if (!result.ok && result.code === "unavailable") {
    throw new Error(result.message);
  }
  return result;
}

export function useActiveCompany(communityId: string, enabled = true) {
  return useQuery({
    queryKey: activeCompanyQueryKey(communityId),
    queryFn: async () =>
      requireAvailable(await companyRepository.getActiveCompany()),
    enabled: enabled && communityId !== "",
    staleTime: 30_000,
  });
}

export function useInitiatives(communityId: string, enabled = true) {
  return useQuery({
    queryKey: initiativesQueryKey(communityId),
    queryFn: async () =>
      requireAvailable(await companyRepository.listInitiatives()),
    enabled: enabled && communityId !== "",
    staleTime: 15_000,
  });
}

export function useInitiative(
  communityId: string,
  initiativeId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: initiativeQueryKey(communityId, initiativeId ?? ""),
    queryFn: async () =>
      requireAvailable(
        await companyRepository.getInitiative(initiativeId as string),
      ),
    enabled: enabled && communityId !== "" && !!initiativeId,
    staleTime: 15_000,
  });
}

/** Cohorts are inert data: one read, no live-status refetch pressure. */
export function useCohorts(communityId: string, enabled = true) {
  return useQuery({
    queryKey: cohortsQueryKey(communityId),
    queryFn: async () =>
      requireAvailable(await companyRepository.listCohorts()),
    enabled: enabled && communityId !== "",
    staleTime: 30_000,
  });
}

export function useCompanyTasks(
  communityId: string,
  scope: TaskQuery,
  enabled = true,
) {
  return useQuery({
    queryKey: tasksQueryKey(communityId, scope),
    queryFn: async () =>
      requireAvailable(await companyRepository.listTasks(scope)),
    enabled: enabled && communityId !== "",
    staleTime: 15_000,
  });
}

export function useTask(
  communityId: string,
  taskId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: taskQueryKey(communityId, taskId ?? ""),
    queryFn: async () =>
      requireAvailable(await companyRepository.getTask(taskId as string)),
    enabled: enabled && communityId !== "" && !!taskId,
    staleTime: 15_000,
  });
}

export function useThreadTasks(
  communityId: string,
  threadRoot: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: threadTasksQueryKey(communityId, threadRoot ?? ""),
    queryFn: async () =>
      requireAvailable(
        await companyRepository.listThreadTasks({
          threadRoot: threadRoot as string,
        }),
      ),
    enabled: enabled && communityId !== "" && !!threadRoot,
    staleTime: 15_000,
  });
}

/** One DM conversation's tasks: the conversation is the thread. */
export function useConversationTasks(
  communityId: string,
  channelId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: conversationTasksQueryKey(communityId, channelId ?? ""),
    queryFn: async () =>
      requireAvailable(
        await companyRepository.listConversationTasks(channelId as string),
      ),
    enabled: enabled && communityId !== "" && !!channelId,
    staleTime: 15_000,
  });
}

/**
 * The task a thread currently has open, or `null`.
 *
 * A thread holds at most one, so "the newest live one" is the whole rule.
 * Terminal tasks are history, and hidden tasks never reach this list at all:
 * the repository drops them, because a task that only carries the cost of
 * small talk is not work anyone can be shown or asked to close.
 */
export function useThreadOpenTask(
  communityId: string,
  input: {
    channelId: string | null;
    channelType: ChannelType | null;
    threadRootId: string | null;
  },
) {
  const isConversation = input.channelType === "dm";
  const threadQuery = useThreadTasks(
    communityId,
    isConversation ? null : input.threadRootId,
  );
  const conversationQuery = useConversationTasks(
    communityId,
    isConversation ? input.channelId : null,
  );
  const result = isConversation ? conversationQuery.data : threadQuery.data;
  const tasks = result?.ok ? result.value : [];
  return tasks.find((task) => !isTerminalTaskStatus(task.status)) ?? null;
}
