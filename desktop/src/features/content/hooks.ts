/**
 * React Query access to the content calendar.
 *
 * Every key starts with the community id. Switching community remounts the
 * subtree but the query cache survives, so a key that omitted it would serve
 * the previous community's campaign to the next one.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCommunityOwnersQuery } from "@/features/agents/communityOwners";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent, uploadMediaBytes } from "@/shared/api/tauri";

import { evaluateClaimGate, verifyClaims } from "./claimVerifier";
import { claimVerifierDependencies } from "./claimVerifierRuntime";
import { contentRepository, HOUSE_STYLE_SCOPE } from "./contentRepository";
import type { ContentPost } from "./contracts";
import type { DecisionInput } from "./contentDecisions";
import { buildDecisionEvent } from "./contentDecisions";
import { loadKitFontFace } from "./render/fontKit";
import type { PipelineOutcome } from "./render/pipeline";
import { renderPost } from "./renderPost";
import { buildRenderedPostEvent } from "./renderedPostEvent";

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

export function brandKitQueryKey(communityId: string) {
  return [CONTENT_ROOT, communityId, "brand-kit"] as const;
}

/**
 * The workspace's brand kit.
 *
 * Cached a minute alongside strictness, which is read out of the same record:
 * the renderer asks for it once per card and a kit changes rarely.
 */
export function useContentBrandKit(communityId: string, enabled = true) {
  return useQuery({
    enabled: enabled && communityId.length > 0,
    queryFn: () => contentRepository.getBrandKit(),
    queryKey: brandKitQueryKey(communityId),
    staleTime: 60_000,
  });
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
 * Live claim verification for one post, keyed by claim id.
 *
 * Runs on every mount of the day detail: a page check is a local HTTP
 * request, so freshness is free, and a stale tick is the one thing this
 * screen must not show. Owner pubkeys come from the membership snapshot; a
 * still-loading set fails closed, so nothing reads owner-signed before
 * ownership is known.
 */
export function useClaimVerification(communityId: string, post: ContentPost) {
  const ownersQuery = useCommunityOwnersQuery(communityId);
  const owners = ownersQuery.data;
  // In the key so verification re-runs once the snapshot lands: an owner
  // claim checked against a still-loading set failed closed, and it must not
  // keep that verdict after ownership becomes known.
  const ownersKey = owners ? [...owners].sort().join(",") : "loading";
  return useQuery({
    enabled: post.claims.length > 0,
    queryFn: () =>
      verifyClaims(post.claims, claimVerifierDependencies(owners ?? new Set())),
    queryKey: [
      CONTENT_ROOT,
      communityId,
      "claim-verification",
      post.eventId,
      post.updatedAt,
      ownersKey,
    ],
    staleTime: 0,
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

/** What a render attempt reports back to the screen. */
export type RenderPostOutcome = {
  outcome: PipelineOutcome;
  /** The published event id, absent when the text gates blocked the render. */
  eventId: string | null;
};

/**
 * Render one post's cards, upload them, and write the result onto the post.
 *
 * The order is the product, and it is enforced by `renderCard` rather than
 * here: the text gates run first, and a card they block never costs a
 * rasterisation or an upload. A blocked outcome is a successful call that
 * produced no images, not an error, because the screen needs the blocking
 * gates in order to say what to fix.
 *
 * Claims are verified fresh rather than read from the day detail's cache. A
 * render binds a report to bytes; binding it to a verdict that was true ten
 * minutes ago is how a stale claim ships.
 */
export function useRenderContentPost(communityId: string) {
  const queryClient = useQueryClient();
  const ownersQuery = useCommunityOwnersQuery(communityId);
  return useMutation({
    mutationFn: async (post: ContentPost): Promise<RenderPostOutcome> => {
      const [kit, style, strictness, fontFaceCss, body] = await Promise.all([
        contentRepository.getBrandKit(),
        contentRepository.getStyle(HOUSE_STYLE_SCOPE),
        contentRepository.getClaimStrictness(),
        loadKitFontFace(),
        contentRepository.getPostBody(post.address),
      ]);
      if (!body) {
        throw new Error(
          "This post is no longer on the relay, so there is nothing to render onto.",
        );
      }
      const verdicts = await verifyClaims(
        post.claims,
        claimVerifierDependencies(ownersQuery.data ?? new Set()),
      );
      const { outcome, slides } = await renderPost({
        claimGate: evaluateClaimGate(post.claims, verdicts, strictness),
        fontFaceCss,
        kit,
        post,
        renderedAt: new Date().toISOString(),
        // Recorded verbatim on every report: two engine builds do not agree
        // on subpixel output, and contrast is measured in pixels.
        renderer: {
          engine: navigator.userAgent,
          name: "colony-desktop",
        },
        style,
      });
      if (outcome.status === "blocked") {
        return { eventId: null, outcome };
      }

      const images = [];
      for (const slide of slides) {
        // Sequentially, so a carousel does not open four uploads at once
        // against a relay that meters them.
        const blob = await uploadMediaBytes(
          Array.from(slide.png),
          `${post.slug}-${slide.sha256.slice(0, 8)}.png`,
        );
        if (blob.sha256.toLowerCase().replace(/\.png$/, "") !== slide.sha256) {
          throw new Error(
            "The relay stored different bytes than were measured, so no report can name them.",
          );
        }
        images.push({
          height: slide.height,
          sha256: slide.sha256,
          url: blob.url,
          width: slide.width,
        });
      }

      const draft = buildRenderedPostEvent(
        post.address,
        body,
        images,
        outcome.reports,
        style?.version ?? null,
      );
      if (!draft.ok) {
        throw new Error(draft.reason);
      }
      const signed = await signRelayEvent(draft.event);
      const published = await relayClient.publishEvent(
        signed,
        "Timed out while publishing the rendered card.",
        "Failed to publish the rendered card.",
      );
      return { eventId: published?.id ?? signed.id, outcome };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [CONTENT_ROOT, communityId, "posts"],
      });
    },
  });
}
