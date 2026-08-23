/**
 * React Query access to the content calendar.
 *
 * Every key starts with the community id. Switching community remounts the
 * subtree but the query cache survives, so a key that omitted it would serve
 * the previous community's campaign to the next one.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";

import { contentRepository, HOUSE_STYLE_SCOPE } from "./contentRepository";
import type { DecisionInput } from "./contentDecisions";
import { buildDecisionEvent } from "./contentDecisions";

const CONTENT_ROOT = "colony-content" as const;

export function campaignsQueryKey(communityId: string) {
  return [CONTENT_ROOT, communityId, "campaigns"] as const;
}

export function postsQueryKey(communityId: string, campaignId: string) {
  return [CONTENT_ROOT, communityId, "posts", campaignId] as const;
}

export function styleQueryKey(communityId: string, scope: string) {
  return [CONTENT_ROOT, communityId, "style", scope] as const;
}

export function claimStrictnessQueryKey(communityId: string) {
  return [CONTENT_ROOT, communityId, "claim-strictness"] as const;
}

export function decisionsQueryKey(communityId: string) {
  return [CONTENT_ROOT, communityId, "decisions"] as const;
}

export function useContentCampaigns(communityId: string, enabled = true) {
  return useQuery({
    enabled: enabled && communityId.length > 0,
    queryFn: () => contentRepository.listCampaigns(),
    queryKey: campaignsQueryKey(communityId),
  });
}

export function useContentPosts(
  communityId: string,
  campaignId: string,
  enabled = true,
) {
  return useQuery({
    enabled: enabled && communityId.length > 0 && campaignId.length > 0,
    queryFn: () => contentRepository.listPosts(campaignId),
    queryKey: postsQueryKey(communityId, campaignId),
  });
}

export function useContentStyle(
  communityId: string,
  scope: string = HOUSE_STYLE_SCOPE,
  enabled = true,
) {
  return useQuery({
    enabled: enabled && communityId.length > 0,
    queryFn: () => contentRepository.getStyle(scope),
    queryKey: styleQueryKey(communityId, scope),
  });
}

export function useContentDecisions(communityId: string, enabled = true) {
  return useQuery({
    enabled: enabled && communityId.length > 0,
    queryFn: () => contentRepository.listDecisions(),
    queryKey: decisionsQueryKey(communityId),
  });
}

/**
 * The brand kit's claim strictness for the workspace.
 *
 * Cached a minute: the gate reads this on every render pass and the kit
 * changes rarely. Absent or unreadable kit resolves to strict.
 */
export function useContentClaimStrictness(communityId: string, enabled = true) {
  return useQuery({
    enabled: enabled && communityId.length > 0,
    queryFn: () => contentRepository.getClaimStrictness(),
    queryKey: claimStrictnessQueryKey(communityId),
    staleTime: 60_000,
  });
}

/**
 * Approve a post, or send it back with a note.
 *
 * A refusal from `buildDecisionEvent` is thrown rather than silently swallowed
 * so the caller shows the reason. The refusals are the relay's own rules
 * reached one round trip early.
 */
export function useSubmitContentDecision(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: DecisionInput) => {
      const draft = buildDecisionEvent(input);
      if (!draft.ok) {
        throw new Error(draft.reason);
      }
      const signed = await signRelayEvent(draft.event);
      return relayClient.publishEvent(
        signed,
        "Timed out while recording your decision.",
        "Failed to record your decision.",
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: decisionsQueryKey(communityId),
      });
    },
  });
}
