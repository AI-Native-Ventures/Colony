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
import { signRelayEvent } from "@/shared/api/tauri";
import { uploadPngVerbatim } from "@/shared/api/uploadPngVerbatim";

import { KIND_CONTENT_BRAND_KIT } from "@/shared/constants/kinds";
import { uploadMediaBytes } from "@/shared/api/tauri";

import { evaluateClaimGate, verifyClaims } from "./claimVerifier";
import { claimVerifierDependencies } from "./claimVerifierRuntime";
import { contentRepository, HOUSE_STYLE_SCOPE } from "./contentRepository";
import type { CardStyle, ContentPost } from "./contracts";
import type { DecisionInput } from "./contentDecisions";
import { buildDecisionEvent } from "./contentDecisions";
import { loadKitFontFace } from "./render/fontKit";
import { resolveCardMark } from "./render/marksRuntime";
import type { PipelineOutcome } from "./render/pipeline";
import { markDataUri } from "./render/marks";
import {
  deriveLogoVariants,
  rasteriseSvgLogo,
  type DerivedLogoVariants,
} from "./render/marksRuntime";
import { renderPost } from "./renderPost";
import type { RuleOriginInput, StyleVoice } from "./styleRecord";
import {
  addStyleReference,
  appendStyleRule,
  buildStyleEvent,
  recordStylePick,
  removeStyleReference,
  revokeStyleRule,
  setStyleVoice,
} from "./styleRecord";
import { variantTakes } from "./variants";
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

/** Publish a mutated house-style body and refresh every style reader. */
async function publishStyleBody(
  body: Record<string, unknown>,
): Promise<string | null> {
  const signed = await signRelayEvent(buildStyleEvent(HOUSE_STYLE_SCOPE, body));
  const published = await relayClient.publishEvent(
    signed,
    "Timed out while saving your style.",
    "Failed to save your style.",
  );
  return published?.id ?? signed.id ?? null;
}

/**
 * Mutate the house style record.
 *
 * Reads the newest head fresh inside the mutation rather than from the query
 * cache: appending a rule onto a stale body would silently drop whichever
 * rule landed in between.
 */
export function useMutateHouseStyle(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      mutate: (body: Record<string, unknown> | null) => Record<string, unknown>,
    ) => {
      const existing = await contentRepository.getStyleBody(HOUSE_STYLE_SCOPE);
      return publishStyleBody(mutate(existing));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: styleQueryKey(communityId, HOUSE_STYLE_SCOPE),
      });
    },
  });
}

/** Revoke one house rule. The rule stays in the ledger, inactive. */
export function useRevokeStyleRule(communityId: string) {
  const mutateStyle = useMutateHouseStyle(communityId);
  return useMutation({
    mutationFn: (ruleId: string) =>
      mutateStyle.mutateAsync((body) =>
        revokeStyleRule(body, ruleId, Math.floor(Date.now() / 1000)),
      ),
  });
}

/** Save the voice block from the Brand page. */
export function useSetStyleVoice(communityId: string) {
  const mutateStyle = useMutateHouseStyle(communityId);
  return useMutation({
    mutationFn: (voice: StyleVoice) =>
      mutateStyle.mutateAsync((body) =>
        setStyleVoice(body, voice, Math.floor(Date.now() / 1000)),
      ),
  });
}

/**
 * Save one reference screenshot the owner likes.
 *
 * Uploaded through the ordinary media path (sanitised: it is a person's
 * file), then listed on the style record so the agent can find and study it.
 */
export function useAddStyleReference(communityId: string) {
  const mutateStyle = useMutateHouseStyle(communityId);
  return useMutation({
    mutationFn: async (input: { bytes: number[]; filename?: string }) => {
      const blob = await uploadMediaBytes(input.bytes, input.filename);
      return mutateStyle.mutateAsync((body) =>
        addStyleReference(body, {
          added_at: Math.floor(Date.now() / 1000),
          sha256: blob.sha256.toLowerCase().replace(/\.png$/, ""),
          url: blob.url,
        }),
      );
    },
  });
}

/** Remove one reference from the board. */
export function useRemoveStyleReference(communityId: string) {
  const mutateStyle = useMutateHouseStyle(communityId);
  return useMutation({
    mutationFn: (sha256: string) =>
      mutateStyle.mutateAsync((body) =>
        removeStyleReference(body, sha256, Math.floor(Date.now() / 1000)),
      ),
  });
}

/**
 * Set the workspace's logo on its brand kit.
 *
 * SVG is rasterised client-side (the relay refuses SVG uploads), everything
 * else goes through the ordinary media path. The kit body is merged, never
 * rebuilt, so fields the desktop does not read survive the write. Replaces
 * the existing `logo` mark and leaves other roles alone.
 */
export function useSetBrandLogo(communityId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      bytes: number[];
      filename?: string;
      isSvg?: boolean;
    }) => {
      const kit = await contentRepository.getBrandKitBody();
      if (!kit) {
        throw new Error(
          "Your brand has not been set up yet. Ask your agent to scan your website first.",
        );
      }
      const bytes = input.isSvg
        ? Array.from(
            await rasteriseSvgLogo(
              new TextDecoder().decode(Uint8Array.from(input.bytes)),
            ),
          )
        : input.bytes;
      // One logo in, every version the cards need out: the background
      // lifted, a white version for dark grounds, an ink one for light.
      // Derivation failing must not block the logo itself, so it degrades
      // to the pre-variant single upload.
      let derived: DerivedLogoVariants | null = null;
      try {
        derived = await deriveLogoVariants(Uint8Array.from(bytes));
      } catch {
        derived = null;
      }
      const blob = await uploadMediaBytes(
        derived ? Array.from(derived.base) : bytes,
        input.filename,
      );
      const variants: Record<string, string>[] = [];
      if (derived) {
        for (const [purpose, versionBytes] of [
          ["on-dark", derived.onDark],
          ["on-light", derived.onLight],
        ] as const) {
          const uploaded = await uploadMediaBytes(
            Array.from(versionBytes),
            input.filename,
          );
          variants.push({
            media_hash: uploaded.sha256.toLowerCase().replace(/\.png$/, ""),
            media_url: uploaded.url,
            purpose,
          });
        }
      }
      const marks = Array.isArray(kit.body.marks)
        ? kit.body.marks.filter(
            (entry) =>
              typeof entry === "object" &&
              entry !== null &&
              (entry as { role?: unknown }).role !== "logo",
          )
        : [];
      const signed = await signRelayEvent({
        content: JSON.stringify({
          ...kit.body,
          marks: [
            ...marks,
            {
              media_hash: blob.sha256.toLowerCase().replace(/\.png$/, ""),
              media_url: blob.url,
              role: "logo",
              ...(variants.length > 0 ? { variants } : {}),
            },
          ],
        }),
        kind: KIND_CONTENT_BRAND_KIT,
        tags: [["d", kit.kitId]],
      });
      return relayClient.publishEvent(
        signed,
        "Timed out while saving your logo.",
        "Failed to save your logo.",
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: brandKitQueryKey(communityId),
      });
    },
  });
}

/**
 * Approve a post, or send it back with a note.
 *
 * A refusal from `buildDecisionEvent` is thrown rather than silently swallowed
 * so the caller shows the reason. The refusals are the relay's own rules
 * reached one round trip early.
 *
 * A change request whose correction is binned "every card, from now on" also
 * lands as a house rule, in the owner's exact sentence, citing the decision
 * it rode in on. This is the promotion the Style ledger always promised and
 * never had a writer for. The decision publishes first: if the rule write
 * then fails, the change request still exists and the error says which half
 * needs retrying.
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
      const published = await relayClient.publishEvent(
        signed,
        "Timed out while recording your decision.",
        "Failed to record your decision.",
      );
      if (input.correction?.bin === "rule") {
        const origin: RuleOriginInput = {
          at: Math.floor(Date.now() / 1000),
          event: published?.id ?? signed.id ?? null,
          quote: input.note?.trim() || input.correction.text,
        };
        try {
          const existing =
            await contentRepository.getStyleBody(HOUSE_STYLE_SCOPE);
          await publishStyleBody(
            appendStyleRule(existing, input.correction.text, origin),
          );
          void queryClient.invalidateQueries({
            queryKey: styleQueryKey(communityId, HOUSE_STYLE_SCOPE),
          });
        } catch (cause) {
          throw new Error(
            `Your change was sent, but saving it as a house rule failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
          );
        }
      }
      return published;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: decisionsQueryKey(communityId),
      });
    },
  });
}

/** One drawn take: a picture to tap, and the style that tap means. */
export type DrawnTake = {
  label: string;
  /** First slide of the take, as a data: URI for immediate display. */
  imageUri: string;
  style: CardStyle;
};

export type VariantTakesOutcome =
  | { status: "drawn"; takes: DrawnTake[] }
  | { status: "blocked"; blocking: { id: string; detail: string }[] };

/**
 * Draw up to three takes on one post, locally, uploading nothing.
 *
 * The owner picks by looking; only the picked take is then rendered for
 * real, uploaded and recorded. The text gates run once up front: they read
 * words, not pixels, so a claim that blocks one take blocks all of them and
 * there is no point drawing any.
 */
export function useDraftVariantTakes(communityId: string) {
  const ownersQuery = useCommunityOwnersQuery(communityId);
  return useMutation({
    mutationFn: async (post: ContentPost): Promise<VariantTakesOutcome> => {
      const [kit, style, strictness, fontFaceCss] = await Promise.all([
        contentRepository.getBrandKit(),
        contentRepository.getStyle(HOUSE_STYLE_SCOPE),
        contentRepository.getClaimStrictness(),
        loadKitFontFace(),
      ]);
      const mark = await resolveCardMark(kit);
      const verdicts = await verifyClaims(
        post.claims,
        claimVerifierDependencies(ownersQuery.data ?? new Set()),
      );
      const claimGate = evaluateClaimGate(post.claims, verdicts, strictness);
      const takes: DrawnTake[] = [];
      for (const take of variantTakes(post, kit)) {
        const { outcome, slides } = await renderPost({
          claimGate,
          fontFaceCss,
          kit,
          mark,
          post: { ...post, style: take.style },
          renderedAt: new Date().toISOString(),
          renderer: { engine: navigator.userAgent, name: "colony-desktop" },
          style,
        });
        if (outcome.status === "blocked") {
          return { blocking: outcome.blocking, status: "blocked" };
        }
        const first = slides[0];
        if (!first) {
          continue;
        }
        takes.push({
          imageUri: markDataUri(first.png, "image/png"),
          label: take.label,
          style: take.style,
        });
      }
      return { status: "drawn", takes };
    },
  });
}

/** Record which take the owner picked. Taste data, not prose. */
export function useRecordStylePick(communityId: string) {
  const mutateStyle = useMutateHouseStyle(communityId);
  return useMutation({
    mutationFn: (input: { post: ContentPost; style: CardStyle }) =>
      mutateStyle.mutateAsync((body) =>
        recordStylePick(body, {
          at: Math.floor(Date.now() / 1000),
          chosen: {
            ...(input.style.family !== null
              ? { family: input.style.family }
              : {}),
            hues: input.style.hues,
            ...(input.style.layout !== null
              ? { layout: input.style.layout }
              : {}),
          },
          post: input.post.address,
        }),
      ),
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
export type RenderPostRequest = {
  post: ContentPost;
  /**
   * A take the owner picked instead of the drafted look. The render draws it
   * and the published head records it, so the card and its record agree.
   */
  style?: CardStyle;
};

export function useRenderContentPost(communityId: string) {
  const queryClient = useQueryClient();
  const ownersQuery = useCommunityOwnersQuery(communityId);
  return useMutation({
    mutationFn: async ({
      post: basePost,
      style: styleOverride,
    }: RenderPostRequest): Promise<RenderPostOutcome> => {
      const post = styleOverride
        ? { ...basePost, style: styleOverride }
        : basePost;
      const [kit, style, strictness, fontFaceCss, body] = await Promise.all([
        contentRepository.getBrandKit(),
        contentRepository.getStyle(HOUSE_STYLE_SCOPE),
        contentRepository.getClaimStrictness(),
        loadKitFontFace(),
        contentRepository.getPostBody(post.address),
      ]);
      // The workspace's own mark, fetched and inlined; Colony's ant only for
      // Colony's own kit. Resolved fresh alongside the kit so a logo changed
      // on the Brand page reaches the very next render.
      const mark = await resolveCardMark(kit);
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
        mark,
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
        // Verbatim, not `uploadMediaBytes`: that command strips metadata by
        // re-encoding the image, and the re-encoded blob hashes differently
        // from the bytes measured here. The check below is what caught it.
        const blob = await uploadPngVerbatim(
          Array.from(slide.png),
          `${post.slug}-${slide.sha256.slice(0, 8)}.png`,
        );
        const stored = blob.sha256.toLowerCase().replace(/\.png$/, "");
        if (stored !== slide.sha256) {
          throw new Error(
            `The relay stored ${stored.slice(0, 12)}… but this card measured ${slide.sha256.slice(0, 12)}…, so no report can name the stored bytes.`,
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
        styleOverride ? { ...body, style: styleOverride.raw } : body,
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
