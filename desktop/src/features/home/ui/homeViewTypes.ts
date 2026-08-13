import type { HomeFeedResponse } from "@/shared/api/types";

/** Search-state keys HomeView syncs with the location search string. */
export const INBOX_SEARCH_KEYS = [
  "item",
  "profile",
  "profileTab",
  "profileView",
] as const;

export type HomeViewProps = {
  feed?: HomeFeedResponse;
  isLoading?: boolean;
  errorMessage?: string;
  currentPubkey?: string;
  availableChannelIds: ReadonlySet<string>;
  onOpenContext: (
    channelId: string,
    messageId: string,
    threadRootId?: string | null,
  ) => void;
  onRefresh: () => void;
};
