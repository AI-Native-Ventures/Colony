/**
 * Reading the content calendar off the relay.
 *
 * Unlike the company records next door, none of these are relay-authored, so
 * no query pins `authors` to the relay signer: a campaign is written by
 * whichever agent the workspace hired to write it. What bounds the read is the
 * community itself, which the relay already enforces on every filter.
 *
 * Nothing is cached to disk. An unpublished campaign is commercial material,
 * and having last month's launch plan outlive a community switch is a leak.
 */

import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_CONTENT_BRAND_KIT,
  KIND_CONTENT_CAMPAIGN,
  KIND_CONTENT_DECISION,
  KIND_CONTENT_POST,
  KIND_CONTENT_STYLE,
} from "@/shared/constants/kinds";

import type {
  ClaimStrictness,
  ContentCampaign,
  ContentDecision,
  ContentPost,
  ContentStyle,
} from "./contracts";
import type { BrandKit } from "./render/kit";
import { readBrandKit } from "./render/kit";
import {
  parseCampaign,
  parseEventBody,
  parseClaimStrictness,
  parseDecision,
  parsePost,
  parseStyle,
} from "./contracts";

/**
 * A campaign is two weeks of five posts in the case we have; a busy workspace
 * running several at once is still well inside this. It exists so a relay
 * returning far more than a person could read does not become an unbounded
 * render.
 */
const MAX_RECORDS = 500;

/** Default scope for the house-style head. */
export const HOUSE_STYLE_SCOPE = "house";

/**
 * Bumped by `resetContentRepositoryState()`. A read that started before a
 * community switch resolves after it, and must not deliver the old
 * community's calendar into the new one.
 */
let repositoryGeneration = 0;

export type ContentRepositoryDependencies = {
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
};

/**
 * Newest event per `d` tag.
 *
 * A relay still holding a superseded revision, or a mesh delivering two out of
 * order, would otherwise show one card twice with different contents. Ties
 * break on event id so two clients reduce the same set identically rather than
 * disagreeing about which of two same-second revisions is current.
 */
function newestHeads(events: RelayEvent[]): RelayEvent[] {
  const byCoordinate = new Map<string, RelayEvent>();
  for (const event of events) {
    const coordinate = event.tags.find((tag) => tag[0] === "d")?.[1];
    if (coordinate === undefined) {
      continue;
    }
    const held = byCoordinate.get(coordinate);
    if (
      !held ||
      event.created_at > held.created_at ||
      (event.created_at === held.created_at && event.id < held.id)
    ) {
      byCoordinate.set(coordinate, event);
    }
  }
  return [...byCoordinate.values()];
}

export function createContentRepository(
  dependencies: ContentRepositoryDependencies,
) {
  async function read<T>(
    filter: RelaySubscriptionFilter,
    collect: (events: RelayEvent[]) => T,
  ): Promise<T | null> {
    const generation = repositoryGeneration;
    const events = await dependencies.fetchEvents(filter);
    if (generation !== repositoryGeneration) {
      return null;
    }
    return collect(events);
  }

  return {
    /** Every campaign in the workspace, active first, newest first within. */
    async listCampaigns(): Promise<ContentCampaign[]> {
      const campaigns = await read(
        { kinds: [KIND_CONTENT_CAMPAIGN], limit: MAX_RECORDS },
        (events) =>
          newestHeads(events)
            .map(parseCampaign)
            .filter(
              (campaign): campaign is ContentCampaign => campaign !== null,
            ),
      );
      if (!campaigns) {
        return [];
      }
      return campaigns.sort((left, right) => {
        if (left.status !== right.status) {
          return left.status === "active" ? -1 : 1;
        }
        return right.updatedAt - left.updatedAt;
      });
    },

    /**
     * One campaign's posts, in the order they will be posted.
     *
     * Filtered client-side rather than by relay filter: `d` is
     * `<campaign>:<slug>`, and NIP-01 `#d` matches whole values, not prefixes.
     * Fetching the workspace's posts and selecting here is correct where a
     * prefix filter would silently return nothing.
     */
    async listPosts(campaignId?: string): Promise<ContentPost[]> {
      const posts = await read(
        { kinds: [KIND_CONTENT_POST], limit: MAX_RECORDS },
        (events) =>
          newestHeads(events)
            .map(parsePost)
            .filter((post): post is ContentPost => post !== null),
      );
      if (!posts) {
        return [];
      }
      return posts
        .filter((post) => !campaignId || post.campaign === campaignId)
        .sort(
          (left, right) =>
            left.week - right.week ||
            left.scheduledFor.localeCompare(right.scheduledFor) ||
            left.slug.localeCompare(right.slug),
        );
    },

    /**
     * One post's head as the relay stores it, body unparsed.
     *
     * The renderer writes its result back onto the post, and a body rebuilt
     * from the parsed record would drop every field the relay stores
     * opaquely. So the write path merges into this rather than into a
     * `ContentPost`.
     */
    async getPostBody(
      address: string,
    ): Promise<Record<string, unknown> | null> {
      const heads = await read(
        { kinds: [KIND_CONTENT_POST], "#d": [address], limit: 8 },
        (events) => newestHeads(events),
      );
      const head = heads?.at(0);
      return head ? parseEventBody(head) : null;
    },

    /** The house style, or a named campaign's override. */
    async getStyle(
      scope: string = HOUSE_STYLE_SCOPE,
    ): Promise<ContentStyle | null> {
      const styles = await read(
        { kinds: [KIND_CONTENT_STYLE], "#d": [scope], limit: 8 },
        (events) =>
          newestHeads(events)
            .map(parseStyle)
            .filter((style): style is ContentStyle => style !== null),
      );
      return styles?.at(0) ?? null;
    },

    /**
     * The claim gate's strictness from the workspace's brand kit.
     *
     * One kit per workspace at launch, so the newest kind-30198 head is the
     * kit. A missing or unreadable kit defaults to strict: strict is the
     * product's promise, and an absent setting is not permission to publish
     * unchecked claims.
     */
    async getClaimStrictness(): Promise<ClaimStrictness> {
      const heads = await read(
        { kinds: [KIND_CONTENT_BRAND_KIT], limit: MAX_RECORDS },
        (events) => newestHeads(events),
      );
      const head = heads?.at(0);
      return (head && parseClaimStrictness(head)) ?? "strict";
    },

    /**
     * The workspace's brand kit, as the renderer reads it.
     *
     * One kit per workspace at launch, so the newest kind-30198 head is the
     * kit. `readBrandKit` throws on a kit the renderer cannot interpret, and
     * that throw is deliberate: rendering against a half-read kit would
     * produce cards measured against the wrong bars.
     */
    async getBrandKit(): Promise<BrandKit | null> {
      const heads = await read(
        { kinds: [KIND_CONTENT_BRAND_KIT], limit: MAX_RECORDS },
        (events) => newestHeads(events),
      );
      const head = heads?.at(0);
      if (!head) {
        return null;
      }
      const body = parseEventBody(head);
      if (!body) {
        return null;
      }
      // The relay carries the kit id in the `d` tag; a body written by an
      // older CLI may not repeat it, and the reader needs one.
      return readBrandKit({
        id: head.tags.find((tag) => tag[0] === "d")?.[1],
        ...body,
      });
    },

    /**
     * Every owner decision in the workspace, newest first.
     *
     * Read whole rather than per post. A calendar screen needs the state of
     * forty cards at once, and forty filters is forty round trips.
     */
    async listDecisions(): Promise<ContentDecision[]> {
      const decisions = await read(
        { kinds: [KIND_CONTENT_DECISION], limit: MAX_RECORDS },
        (events) =>
          events
            .map(parseDecision)
            .filter(
              (decision): decision is ContentDecision => decision !== null,
            ),
      );
      if (!decisions) {
        return [];
      }
      return decisions.sort((left, right) => right.decidedAt - left.decidedAt);
    },
  };
}

export type ContentRepository = ReturnType<typeof createContentRepository>;

export const contentRepository = createContentRepository({
  fetchEvents: (filter) => relayClient.fetchEvents(filter),
});

/**
 * Wired into `resetCommunityState()`. There is no cache to clear; what this
 * invalidates is every read still in flight against the previous relay.
 */
export function resetContentRepositoryState(): void {
  repositoryGeneration += 1;
}
