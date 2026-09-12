/**
 * Forum reading shapes: a thread and its replies, as the forum surfaces read
 * them. Split out of `types.ts`, which the desktop file ratchet caps, and
 * re-exported from there so every existing import keeps working.
 */

import type { RelayEvent } from "./types";

export type ThreadSummary = {
  replyCount: number;
  descendantCount: number;
  lastReplyAt: number | null;
  participants: string[];
};

export type ForumPost = {
  eventId: string;
  pubkey: string;
  content: string;
  kind: number;
  createdAt: number;
  channelId: string;
  tags: string[][];
  threadSummary: ThreadSummary | null;
};

export type ForumPostsResponse = {
  posts: ForumPost[];
  nextCursor: number | null;
};

export type ThreadReply = {
  eventId: string;
  pubkey: string;
  content: string;
  kind: number;
  createdAt: number;
  channelId: string;
  tags: string[][];
  parentEventId: string | null;
  rootEventId: string | null;
  depth: number;
};

export type ForumThreadResponse = {
  post: ForumPost;
  replies: ThreadReply[];
  totalReplies: number;
  nextCursor: string | null;
};

/**
 * Forward keyset cursor for the server-side thread read (`get_thread_replies`).
 *
 * The event-id tiebreak is load-bearing: thread replies routinely share a
 * `createdAt` second (bursty threads), so a timestamp-only cursor would skip
 * every tied reply past the page limit. The pair `(createdAt, eventId)` orders
 * replies unambiguously and lets paging resume strictly after the last event.
 */
export type ThreadCursor = {
  createdAt: number;
  eventId: string;
};

export type ThreadRepliesResponse = {
  /** The reply subtree (chronological, oldest first), depth >= 1. Excludes the root event (relay keys on `root_event_id`, which a root row lacks); the caller already holds the root. */
  events: RelayEvent[];
  /** Present only when a full page was returned — pass back to fetch the next page. */
  nextCursor: ThreadCursor | null;
};

/**
 * Composite backward keyset cursor for channel-timeline paging via the bridge
 * (`getChannelMessagesBefore`).
 *
 * The event-id tiebreak is load-bearing for the dense-second case: the relay
 * orders `created_at DESC, id ASC` and advances past a second denser than one
 * page with `id > eventId`. A bare `createdAt` (`until`) cursor cannot escape
 * such a second — it re-returns the same slice forever, leaving older history
 * unreachable. `(createdAt, eventId)` moves strictly older every page.
 */
