import { useQuery } from "@tanstack/react-query";

import { companyRepository } from "./companyRepository";
import type { CompanyParseResult } from "./contracts";

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

export function companyQueryKey(communityId: string, companyId: string) {
  return [COMPANY_ROOT, communityId, "profile", companyId] as const;
}

export function initiativesQueryKey(communityId: string, companyId: string) {
  return [COMPANY_ROOT, communityId, "initiatives", companyId] as const;
}

export function initiativeQueryKey(communityId: string, initiativeId: string) {
  return [COMPANY_ROOT, communityId, "initiative", initiativeId] as const;
}

export function tasksQueryKey(
  communityId: string,
  scope: { companyId?: string; initiativeId?: string },
) {
  return [
    COMPANY_ROOT,
    communityId,
    "tasks",
    scope.companyId ?? "",
    scope.initiativeId ?? "",
  ] as const;
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

export function useCompany(
  communityId: string,
  companyId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: companyQueryKey(communityId, companyId ?? ""),
    queryFn: async () =>
      requireAvailable(await companyRepository.getCompany(companyId as string)),
    enabled: enabled && communityId !== "" && !!companyId,
    staleTime: 30_000,
  });
}

export function useInitiatives(
  communityId: string,
  companyId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: initiativesQueryKey(communityId, companyId ?? ""),
    queryFn: async () =>
      requireAvailable(
        await companyRepository.listInitiatives(companyId as string),
      ),
    enabled: enabled && communityId !== "" && !!companyId,
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

export function useCompanyTasks(
  communityId: string,
  scope: { companyId?: string; initiativeId?: string },
  enabled = true,
) {
  const scoped = !!scope.companyId || !!scope.initiativeId;
  return useQuery({
    queryKey: tasksQueryKey(communityId, scope),
    queryFn: async () =>
      requireAvailable(await companyRepository.listTasks(scope)),
    enabled: enabled && communityId !== "" && scoped,
    staleTime: 15_000,
  });
}
