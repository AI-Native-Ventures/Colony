import type { OpenAsk } from "@/features/asks/lib/askEvent";
import type { InboxItem } from "@/features/home/lib/inbox";
import { formatInboxFullTimestamp } from "@/features/home/lib/inbox";
import type { FeedItem } from "@/shared/api/types";
import { KIND_ASK } from "@/shared/constants/kinds";

/**
 * Present an open ask as an inbox item.
 *
 * Asks go through the existing inbox rather than a new screen: the inbox
 * already models "this needs you" through `isActionRequired` and the
 * `needs_action` filter, and a founder with two inboxes checks neither.
 */
export function askToInboxItem(ask: OpenAsk, senderLabel: string): InboxItem {
  const timestamp = new Date(ask.createdAt * 1_000);
  const cost = ask.costOfDelay
    ? `Waiting costs: ${ask.costOfDelay}`
    : "No cost of delay stated.";
  const feedItem: FeedItem = {
    category: "needs_action",
    channelId: null,
    channelName: "",
    content: ask.rawContent,
    createdAt: ask.createdAt,
    id: ask.id,
    kind: KIND_ASK,
    pubkey: ask.filerPubkey,
    tags: [],
  };

  return {
    avatarUrl: null,
    conversationId: ask.id,
    id: ask.id,
    item: feedItem,
    categories: ["needs_action"],
    categoryLabel: `Ask · ${ask.askType}`,
    channelLabel: null,
    fullTimestampLabel: formatInboxFullTimestamp(ask.createdAt),
    groupItems: [],
    isActionRequired: true,
    latestActivityAt: ask.createdAt,
    mentionNames: [],
    preview: cost,
    senderLabel,
    subject: ask.headline,
    timestampLabel: timestamp.toLocaleTimeString(),
    unreadCount: 1,
  };
}
