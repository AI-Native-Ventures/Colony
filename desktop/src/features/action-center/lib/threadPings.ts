import { getReactionTargetId } from "@/features/messages/lib/formatTimelineMessages";
import { getThreadReference } from "@/features/messages/lib/threading";
import { resolveEventAuthorPubkey } from "@/shared/lib/authors";
import type { RelayEvent } from "@/shared/api/types";

/**
 * The fields a ping candidate needs; satisfied directly by the home feed's
 * `FeedItem` (see features/home/hooks.ts) -- no separate relay query fetches
 * candidates, the home feed's `mentions` category already is "messages that
 * p-tag the owner".
 */
export type PingCandidate = {
  id: string;
  pubkey: string;
  content: string;
  createdAt: number;
  channelId: string | null;
  channelName: string;
  tags: string[][];
};

export type ThreadPing = {
  id: string;
  channelId: string;
  channelName: string;
  /** Resolved thread root id, for the answering + navigation paths (item 4). */
  threadId: string;
  createdAt: number;
  content: string;
};

/** Query key prefix shared by the batched data query and dismissal's invalidate. */
export const THREAD_PINGS_QUERY_KEY = ["thread-pings"] as const;

/**
 * Only the newest N mentions are checked for pings. This is a silent
 * coverage limit, not a bug: a ping past this position in the home feed's
 * mention list goes unnoticed until it ages into the newest N. The lane is
 * mounted permanently for the sidebar badge, not only while Action Center is
 * open -- ranked-queue-model deleted an unbounded poll for exactly this
 * reason, and this cap is what keeps this lane from reintroducing one.
 * Candidates with no channel are dropped outright: there is nothing to
 * navigate to or dismiss in.
 */
export const PING_CANDIDATE_LIMIT = 20;

export function selectPingCandidates<T extends PingCandidate>(
  mentions: readonly T[],
): T[] {
  return mentions
    .filter((item) => item.channelId !== null)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, PING_CANDIDATE_LIMIT);
}

/**
 * The thread root id a candidate (or a fetched reply event) resolves to: its
 * own `root` tag, falling back to the `reply` tag, falling back to itself
 * when neither is present -- it has no parent, so it IS the root. Same
 * fallback chain used throughout messages/home (e.g.
 * useInboxThreadContext.ts's getThreadRootId, home/lib/inbox.ts).
 */
export function resolvePingRootId(
  event: Pick<PingCandidate, "id" | "tags">,
): string {
  const ref = getThreadReference(event.tags);
  return ref.rootId ?? ref.parentId ?? event.id;
}

/**
 * Root ids that need a batched lookup to learn who authored them: only
 * candidates that are themselves a reply (root id differs from the
 * candidate's own id). A self-rooted candidate's author is already known
 * from the candidate itself -- no fetch needed for it.
 */
export function selectRootIdsNeedingLookup(
  candidates: readonly PingCandidate[],
): string[] {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const rootId = resolvePingRootId(candidate);
    if (rootId !== candidate.id) {
      ids.add(rootId);
    }
  }
  return [...ids];
}

/** Every distinct resolved root id, self-rooted candidates included -- the reply check needs all of them. */
export function selectAllRootIds(
  candidates: readonly PingCandidate[],
): string[] {
  return [...new Set(candidates.map(resolvePingRootId))];
}

function isAuthoredByOwner(
  event: RelayEvent,
  ownerPubkey: string,
  relaySelfPubkey: string | null,
): boolean {
  return (
    resolveEventAuthorPubkey({
      event,
      preferActorTag: true,
      relaySelfPubkey,
      requireChannelTagForPTags: true,
    }).toLowerCase() === ownerPubkey.toLowerCase()
  );
}

export type ThreadPingContext = {
  ownerPubkey: string;
  relaySelfPubkey: string | null;
  /** Root events fetched in one `ids` query, for candidates that are replies. */
  rootEvents: readonly RelayEvent[];
  /** Message-kind events `#e`-referencing any resolved root id (any thread, any candidate). */
  replyEvents: readonly RelayEvent[];
  /** kind:7 events `#e`-referencing a candidate's own id. */
  reactionEvents: readonly RelayEvent[];
};

/**
 * Ping detection + suppression from already-fetched, batched data. Never
 * fetches anything itself -- see useThreadPings for the three bounded
 * queries this consumes (root lookup, reply lookup, reaction lookup).
 *
 * Fail-closed by design (spec: "prefer under-surfacing"): a candidate whose
 * root event the batched lookup could not find (relay miss, not "no lookup
 * needed") is dropped rather than guessed at, since its authorship can no
 * longer be established cheaply.
 */
export function selectUnansweredPings(
  candidates: readonly PingCandidate[],
  context: ThreadPingContext,
): ThreadPing[] {
  const {
    ownerPubkey,
    relaySelfPubkey,
    rootEvents,
    replyEvents,
    reactionEvents,
  } = context;
  const rootEventsById = new Map(rootEvents.map((event) => [event.id, event]));
  const normalizedOwner = ownerPubkey.toLowerCase();

  const pings: ThreadPing[] = [];

  for (const candidate of candidates) {
    if (!candidate.channelId) continue;

    const rootId = resolvePingRootId(candidate);

    let ownerAuthoredRoot: boolean;
    if (rootId === candidate.id) {
      // Self-rooted: the candidate IS the root, so its own signer is the
      // root author. No fetch needed, and no attribution resolution either
      // -- a top-level ping's signer is reliably its visible author.
      ownerAuthoredRoot = candidate.pubkey.toLowerCase() === normalizedOwner;
    } else {
      const rootEvent = rootEventsById.get(rootId);
      if (!rootEvent) continue; // cannot cheaply verify -> drop, not guess
      ownerAuthoredRoot = isAuthoredByOwner(
        rootEvent,
        ownerPubkey,
        relaySelfPubkey,
      );
    }

    if (ownerAuthoredRoot) continue;

    const ownerRepliedSince = replyEvents.some((reply) => {
      if (reply.created_at <= candidate.createdAt) return false;
      if (resolvePingRootId(reply) !== rootId) return false;
      return isAuthoredByOwner(reply, ownerPubkey, relaySelfPubkey);
    });
    if (ownerRepliedSince) continue;

    const ownerReacted = reactionEvents.some((reaction) => {
      if (getReactionTargetId(reaction.tags) !== candidate.id) return false;
      return isAuthoredByOwner(reaction, ownerPubkey, relaySelfPubkey);
    });
    if (ownerReacted) continue;

    pings.push({
      id: candidate.id,
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      threadId: rootId,
      createdAt: candidate.createdAt,
      content: candidate.content,
    });
  }

  return pings;
}
