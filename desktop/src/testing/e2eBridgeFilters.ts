import type { RelayEvent } from "@/shared/api/types";

/** Nostr filters understood by the in-memory relay fixture. */
export type MockFilter = {
  "#a"?: string[];
  "#d"?: string[];
  "#e"?: string[];
  "#grant"?: string[];
  "#h"?: string[];
  "#p"?: string[];
  authors?: string[];
  ids?: string[];
  kinds?: number[];
  limit?: number;
  since?: number;
  until?: number;
};

/** Apply identity and scope constraints before limiting a mock relay result. */
export function mockEventMatchesFilter(
  event: RelayEvent,
  filter: MockFilter,
): boolean {
  const authors = filter.authors?.map((author) => author.toLowerCase());
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (authors && !authors.includes(event.pubkey.toLowerCase())) return false;
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }
  for (const [tagName, values] of [
    ["a", filter["#a"]],
    ["d", filter["#d"]],
    ["e", filter["#e"]],
    ["h", filter["#h"]],
    ["p", filter["#p"]],
  ] as const) {
    if (
      values &&
      !event.tags.some((tag) => tag[0] === tagName && values.includes(tag[1]))
    ) {
      return false;
    }
  }
  return true;
}

/** Mirror the relay's newest-first page selection and chronological delivery. */
export function selectMockChannelHistory(
  events: readonly RelayEvent[],
  filter: MockFilter,
): RelayEvent[] {
  return events
    .filter((event) => mockEventMatchesFilter(event, filter))
    .sort(
      (left, right) =>
        right.created_at - left.created_at || left.id.localeCompare(right.id),
    )
    .slice(0, filter.limit ?? 50)
    .sort(
      (left, right) =>
        left.created_at - right.created_at || left.id.localeCompare(right.id),
    );
}
