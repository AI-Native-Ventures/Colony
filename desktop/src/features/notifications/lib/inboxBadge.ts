/**
 * One open Action Center item, reduced to the two ids that matter for
 * counting. `sourceId` is the id of the thing the item was built from, when
 * another surface could be counting that same thing: a Block carries its feed
 * row's id, a reminder carries its relay event id. Null when nothing else can
 * name it.
 */
export type InboxBadgeActionItem = {
  id: string;
  sourceId: string | null;
};

/** The three surfaces that feed the one Inbox numeral. */
export type InboxBadgeSources = {
  /** Ids of the unread feed rows the home badge counts. */
  feedItemIds: readonly string[];
  /** Relay event ids of reminders that are due. */
  dueReminderEventIds: readonly string[];
  /** Action Center items that are open (needs-action or failed). */
  actionItems: readonly InboxBadgeActionItem[];
};

/**
 * How many distinct things are waiting in the Inbox.
 *
 * The three sources overlap by construction rather than by accident. A due
 * reminder is a reminder and an action. A needs-action feed row is an unread
 * feed row and a Block waiting for an answer. Summing the three counts made
 * one thing read as two, so the count is taken over a set of ids: an action
 * whose `sourceId` another source already named adds nothing, and an action
 * nothing else names is counted on its own id. That keeps an action alive when
 * its counterpart is absent, which is why a Block on an already-read feed row
 * still shows.
 */
export function inboxBadgeCount(sources: InboxBadgeSources): number {
  const counted = new Set<string>(sources.feedItemIds);
  for (const eventId of sources.dueReminderEventIds) {
    counted.add(eventId);
  }
  for (const item of sources.actionItems) {
    if (item.sourceId !== null && counted.has(item.sourceId)) {
      continue;
    }
    counted.add(item.id);
  }
  return counted.size;
}
