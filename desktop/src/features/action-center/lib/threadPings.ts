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
  /** Who p-tagged the owner -- the candidate's own signer, not the thread root's. */
  authorPubkey: string;
  channelId: string;
  /**
   * The channel's display name, resolved from the channels list when the
   * candidate itself didn't carry one (the relay's feed bridge always sends
   * an empty `channel_name` -- see `feed_item_from_event` in
   * `commands/messages.rs`). Empty string when it could not be resolved
   * either way; renderers fall back to something honest rather than a bare
   * "#", never assume this is non-empty.
   */
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
 * Two independent gates, both must pass:
 *
 * 1. Qualification (spec: "sits in a thread the owner participates in") --
 *    owner authored the root, OR owner has posted in the thread at any time.
 *    This is a positive requirement, not a suppression: a fresh mention in a
 *    thread the owner has never touched does not qualify at all, regardless
 *    of replies or reactions. That is deliberate (spec ruling): it is what
 *    keeps an ordinary "hey @owner, can you look at this" from flooding this
 *    lane with plain mentions Home already surfaces -- real first-contact
 *    questions arrive as Asks (kind:44300), tier 1, not here. A self-rooted
 *    candidate (no thread to have posted in yet) only qualifies in the
 *    degenerate case where the owner is themselves the root's author.
 * 2. Suppression, only reached once qualified -- no owner reply newer than
 *    the ping, and no owner reaction on the ping (any emoji).
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
    let ownerRepliesInThread: RelayEvent[];
    if (rootId === candidate.id) {
      // Self-rooted: the candidate IS the root, there is no separate thread
      // the owner could already have posted in. Owner participation can only
      // come from the degenerate case of the owner being the root's own
      // signer -- checked directly, no fetch or attribution resolution
      // needed, since a top-level event's signer is reliably its author.
      ownerAuthoredRoot = candidate.pubkey.toLowerCase() === normalizedOwner;
      ownerRepliesInThread = [];
    } else {
      const rootEvent = rootEventsById.get(rootId);
      if (!rootEvent) continue; // cannot cheaply verify -> drop, not guess
      ownerAuthoredRoot = isAuthoredByOwner(
        rootEvent,
        ownerPubkey,
        relaySelfPubkey,
      );
      ownerRepliesInThread = replyEvents.filter(
        (reply) =>
          resolvePingRootId(reply) === rootId &&
          isAuthoredByOwner(reply, ownerPubkey, relaySelfPubkey),
      );
    }

    const ownerParticipates =
      ownerAuthoredRoot || ownerRepliesInThread.length > 0;
    if (!ownerParticipates) continue; // not a thread the owner is already in

    const ownerRepliedSince = ownerRepliesInThread.some(
      (reply) => reply.created_at > candidate.createdAt,
    );
    if (ownerRepliedSince) continue;

    const ownerReacted = reactionEvents.some((reaction) => {
      if (getReactionTargetId(reaction.tags) !== candidate.id) return false;
      return isAuthoredByOwner(reaction, ownerPubkey, relaySelfPubkey);
    });
    if (ownerReacted) continue;

    pings.push({
      id: candidate.id,
      authorPubkey: candidate.pubkey,
      channelId: candidate.channelId,
      channelName: candidate.channelName,
      threadId: rootId,
      createdAt: candidate.createdAt,
      content: candidate.content,
    });
  }

  return pings;
}

/**
 * Resolves a ping's channel name against the channels list when the
 * candidate itself carried none -- same fallback the home feed uses
 * (`resolveItemChannel` in `features/home/lib/inbox.ts`), applied here
 * because the relay's feed bridge always sends an empty `channel_name` for
 * every mention (see `feed_item_from_event`), so this is the only place a
 * real name is ever attached. Leaves `channelName` empty (never guesses) if
 * the channel is not in the list either -- an unlisted or since-deleted
 * channel the owner just isn't a member of.
 */
export function resolvePingChannelName(
  ping: ThreadPing,
  channelNamesById: ReadonlyMap<string, string>,
): ThreadPing {
  const resolved =
    ping.channelName.trim() || channelNamesById.get(ping.channelId)?.trim();
  if (!resolved || resolved === ping.channelName) return ping;
  return { ...ping, channelName: resolved };
}
