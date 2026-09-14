import {
  MoreUnreadButton,
  type UnreadDmPreview,
} from "@/features/sidebar/ui/MoreUnreadButton";
import { unreadCountLabel } from "@/shared/ui/UnreadPill";

/** The "N new" pill that floats over the top edge of the channel list. */
export function SidebarUnreadAbovePill({
  count,
  onScrollToNextAbove,
}: {
  count: number;
  onScrollToNextAbove: () => void;
}) {
  if (count <= 0) return null;
  return (
    <MoreUnreadButton
      count={count}
      label={unreadCountLabel(count)}
      onClick={onScrollToNextAbove}
      position="top"
      testId="sidebar-more-unread-above"
    />
  );
}

/**
 * The bottom-edge pill. An unread direct message below the fold wins the jump
 * target over the next unread channel, and names the sender on the pill
 * (#6842).
 */
export function SidebarUnreadBelowPill({
  count,
  dmPreviews,
  nextUnreadDmId,
  onScrollToChannel,
  onScrollToNextBelow,
}: {
  count: number;
  dmPreviews: UnreadDmPreview[];
  nextUnreadDmId: string | undefined;
  onScrollToChannel: (channelId: string) => void;
  onScrollToNextBelow: () => void;
}) {
  if (count <= 0) return null;
  return (
    <MoreUnreadButton
      bottomClassName="bottom-full"
      count={count}
      dmPreviews={dmPreviews}
      label={unreadCountLabel(count)}
      onClick={() =>
        nextUnreadDmId
          ? onScrollToChannel(nextUnreadDmId)
          : onScrollToNextBelow()
      }
      position="bottom"
      targetChannelId={nextUnreadDmId}
      testId="sidebar-more-unread-below"
    />
  );
}
