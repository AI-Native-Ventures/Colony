import * as React from "react";
import { VList } from "virtua";
import type { VListHandle } from "virtua";

import { formatDayHeading } from "@/features/messages/lib/dateFormatters";
import { timelineRowReserveStyle } from "@/features/messages/lib/rowHeightEstimate";
import {
  buildTimelineDayGroups,
  buildTimelineItems,
  getTimelineItemKey,
  type TimelineDayGroup,
  type TimelineNonDayItem,
} from "@/features/messages/lib/timelineItems";
import {
  buildVirtualizedItems,
  didPrependVirtualizedTimeline,
  estimateVirtualizedTimelineItemHeight,
  type VirtualizedTimelineItem,
  virtualizedItemKey,
} from "@/features/messages/lib/virtualizedTimelineItems";
import { THREAD_REPLY_ROW_MARGIN_INLINE_REM } from "@/features/messages/lib/threadTreeLayout";
import { buildMainTimelineEntries } from "@/features/messages/lib/threadPanel";
import type { MainTimelineEntry } from "@/features/messages/lib/threadPanel";
import type { ChannelWindowThreadSummary } from "@/features/messages/lib/channelWindowStore";
import {
  buildVideoReviewCommentsByRootId,
  buildVideoReviewContextForMessage,
  hasVideoAttachment,
} from "@/features/messages/lib/videoReviewContext";
import type { TimelineAtBottomReason } from "@/features/messages/lib/semanticBottomTransition";
import type { TimelineMessage } from "@/features/messages/types";
import { useTimelineScrollerResize } from "@/features/messages/ui/useTimelineScrollerResize";
import { canManageMessageForCurrentUser } from "@/features/messages/lib/canManageMessage";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { ChannelType } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import {
  StickyDayDividerOverlay,
  useStickyDayDivider,
} from "./useStickyDayDivider";
import { DayDivider } from "./DayDivider";
import { MessageRow } from "./MessageRow";
import { MessageThreadSummaryRow } from "./MessageThreadSummaryRow";
import { SystemMessageRow } from "./SystemMessageRow";
import { UnreadDivider } from "./UnreadDivider";
import { useTimelineRetention } from "./useTimelineRetention";
import { useUpwardPaginationWheel } from "./useUpwardPaginationWheel";
import { useVirtualizedBottomSettle } from "./useVirtualizedBottomSettle";

export type TimelineVirtualizerApi = {
  cancelBottomIntent: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  settleAtBottom: () => void;
  scrollToMessage: (
    messageId: string,
    options?: { behavior?: ScrollBehavior },
  ) => boolean;
};

type TimelineMessageListProps = {
  channelId?: string | null;
  channelName?: string;
  channelType?: ChannelType | null;
  currentPubkey?: string;
  huddleMemberPubkeys?: readonly string[];
  huddleMemberPubkeysPending?: boolean;
  /** Event id of the oldest unread top-level message; renders a "New" divider above it. */
  firstUnreadMessageId?: string | null;
  followThreadById?: (rootId: string) => void;
  highlightedMessageId?: string | null;
  /** Event id of the thread whose panel is open; its root message row is
   *  highlighted with the accent tint so the open thread is visible from the
   *  channel side. */
  openThreadHeadId?: string | null;
  isFollowingThreadById?: (rootId: string) => boolean;
  isMessageUnreadById?: (messageId: string) => boolean;
  entranceMessageId?: string | null;
  onEntranceMessageComplete?: (messageId: string) => void;
  messageFooters?: Record<string, React.ReactNode>;
  /** Hoisted main-timeline entries (computed once in ChannelPane). Falls back
   *  to deriving them here when omitted (e.g. the deferred-render pass). */
  mainEntries?: MainTimelineEntry[];
  /** Relay thread summaries keyed by thread root id. Keeps badge rows alive on
   *  the deferred-render fallback — replies usually are not local timeline
   *  rows, so without the relay map every summary row unmounts mid-scrollback. */
  threadSummaries?: ReadonlyMap<string, ChannelWindowThreadSummary>;
  messages: TimelineMessage[];
  onDelete?: (message: TimelineMessage) => void;
  onEdit?: (message: TimelineMessage) => void;
  onMarkUnread?: (message: TimelineMessage) => void;
  onMarkRead?: (message: TimelineMessage) => void;
  onReply?: (message: TimelineMessage) => void;
  isSendingVideoReviewComment?: boolean;
  onSendVideoReviewComment?: (
    message: TimelineMessage,
    content: string,
    mentionPubkeys: string[],
    mediaTags?: string[][],
    parentEventId?: string,
  ) => Promise<void>;
  unfollowThreadById?: (rootId: string) => void;
  onToggleReaction?: (
    message: TimelineMessage,
    emoji: string,
    remove: boolean,
  ) => Promise<void>;
  /** Map from lowercase pubkey → persona display name for bot members. */
  personaLookup?: Map<string, string>;
  profiles?: UserProfileLookup;
  ownerProfiles?: UserProfileLookup;
  /** The message ID of the currently active find-in-channel match. */
  searchActiveMessageId?: string | null;
  /** Set of message IDs that match the current find-in-channel query. */
  searchMatchingMessageIds?: Set<string>;
  /** The current find-in-channel query string. */
  searchQuery?: string;
  /** Per-thread unread counts keyed by thread root id. */
  threadUnreadCounts?: ReadonlyMap<string, number>;
  /** Content rendered as the first virtual row before channel history. */
  leadingContent?: React.ReactNode;
  /** Hide date boundaries for a huddle's live transcript. */
  hideDayDividers?: boolean;
  /** Show speaker identity on every row instead of grouping consecutive messages. */
  alwaysShowMessageIdentity?: boolean;
  /** Hide agent access-policy badges in the purpose-built Huddle chat. */
  hideAgentAccessBadges?: boolean;
  /**
   * True when the loaded window provably starts at the channel's beginning.
   * Proves the oldest loaded day's boundary so its divider may render.
   */
  historyExhausted?: boolean;
  /** The virtualized timeline owns its scroll node when enabled. */
  useVirtualizer?: boolean;
  onStartReached?: () => boolean;
  onAtBottomStateChange?: (
    atBottom: boolean,
    reason: TimelineAtBottomReason,
  ) => void;
  onVirtualizerApiChange?: (api: TimelineVirtualizerApi | null) => void;
  onVirtualizerRangeChanged?: () => void;
  onVirtualizerScrollerChange?: (element: HTMLDivElement | null) => void;
};

export const TimelineMessageList = React.memo(function TimelineMessageList({
  channelId,
  channelName,
  channelType,
  currentPubkey,
  firstUnreadMessageId = null,
  followThreadById,
  highlightedMessageId = null,
  openThreadHeadId = null,
  huddleMemberPubkeys,
  huddleMemberPubkeysPending = false,
  isFollowingThreadById,
  isMessageUnreadById,
  entranceMessageId = null,
  onEntranceMessageComplete,
  messageFooters,
  mainEntries,
  threadSummaries,
  messages,
  onDelete,
  onEdit,
  onMarkUnread,
  onMarkRead,
  onReply,
  isSendingVideoReviewComment = false,
  onSendVideoReviewComment,
  onToggleReaction,
  profiles,
  ownerProfiles,
  searchActiveMessageId = null,
  searchMatchingMessageIds,
  searchQuery,
  threadUnreadCounts,
  unfollowThreadById,
  leadingContent,
  historyExhausted = false,
  hideDayDividers = false,
  alwaysShowMessageIdentity = false,
  hideAgentAccessBadges = false,
  useVirtualizer = false,
  onStartReached,
  onAtBottomStateChange,
  onVirtualizerApiChange,
  onVirtualizerRangeChanged,
  onVirtualizerScrollerChange,
}: TimelineMessageListProps) {
  const entries = React.useMemo(
    () =>
      mainEntries ??
      buildMainTimelineEntries(messages, undefined, threadSummaries, profiles),
    [mainEntries, messages, profiles, threadSummaries],
  );
  const reviewCommentsByRootId = React.useMemo(
    () =>
      messages.some(hasVideoAttachment)
        ? buildVideoReviewCommentsByRootId(messages)
        : new Map<string, TimelineMessage[]>(),
    [messages],
  );
  // Contexts are memoized per message id so MessageRow/Markdown memo
  // comparisons hold across unrelated timeline re-renders (typing
  // indicators, presence updates) — a fresh context object per render would
  // defeat the memo and re-render every video message on every pass.
  const videoReviewContextById = React.useMemo(() => {
    const contexts = new Map<
      string,
      NonNullable<ReturnType<typeof buildVideoReviewContextForMessage>>
    >();
    for (const message of messages) {
      const comments = reviewCommentsByRootId.get(message.id) ?? [];
      const context = buildVideoReviewContextForMessage({
        channelId,
        channelName,
        channelType,
        comments,
        isSendingVideoReviewComment,
        message,
        onSendVideoReviewComment,
        onToggleReaction,
        profiles,
      });
      if (context) {
        contexts.set(message.id, context);
      }
    }
    return contexts;
  }, [
    channelId,
    channelName,
    channelType,
    isSendingVideoReviewComment,
    messages,
    onSendVideoReviewComment,
    onToggleReaction,
    profiles,
    reviewCommentsByRootId,
  ]);

  // The flattened item stream, memoized on the entries and the unread boundary
  // (the unread divider is its own item, so it shifts subsequent rows).
  const itemsResult = React.useMemo(
    () => buildTimelineItems(entries, firstUnreadMessageId),
    [entries, firstUnreadMessageId],
  );
  const dayGroups = React.useMemo(
    () => buildTimelineDayGroups(itemsResult.items),
    [itemsResult.items],
  );

  const renderItem = React.useCallback(
    (item: TimelineNonDayItem) => {
      switch (item.kind) {
        case "unread-divider":
          return <UnreadDivider />;
        case "system":
          return (
            <SystemRow
              currentPubkey={currentPubkey}
              entry={item.entry}
              footer={messageFooters?.[item.entry.message.id] ?? null}
              onToggleReaction={onToggleReaction}
              profiles={profiles}
              ownerProfiles={ownerProfiles}
            />
          );
        case "system-group":
          return (
            <SystemRow
              currentPubkey={currentPubkey}
              entries={item.entries}
              footer={item.entries.map(
                (entry) => messageFooters?.[entry.message.id] ?? null,
              )}
              onToggleReaction={onToggleReaction}
              profiles={profiles}
              ownerProfiles={ownerProfiles}
            />
          );
        case "message":
          return (
            <MessageRowItem
              channelId={channelId}
              currentPubkey={currentPubkey}
              entry={item.entry}
              followThreadById={followThreadById}
              footer={messageFooters?.[item.entry.message.id] ?? null}
              highlightedMessageId={highlightedMessageId}
              openThreadHeadId={openThreadHeadId}
              huddleMemberPubkeys={huddleMemberPubkeys}
              huddleMemberPubkeysPending={huddleMemberPubkeysPending}
              hideAgentAccessBadges={hideAgentAccessBadges}
              isContinuation={
                alwaysShowMessageIdentity ? false : item.isContinuation
              }
              isFollowedByContinuation={
                alwaysShowMessageIdentity
                  ? false
                  : item.isFollowedByContinuation
              }
              isFollowingThreadById={isFollowingThreadById}
              isUnread={isMessageUnreadById?.(item.entry.message.id)}
              playEntrance={item.entry.message.id === entranceMessageId}
              onEntranceComplete={onEntranceMessageComplete}
              onDelete={onDelete}
              onEdit={onEdit}
              onMarkRead={onMarkRead}
              onMarkUnread={onMarkUnread}
              onReply={onReply}
              onToggleReaction={onToggleReaction}
              profiles={profiles}
              searchActiveMessageId={searchActiveMessageId}
              searchMatchingMessageIds={searchMatchingMessageIds}
              searchQuery={searchQuery}
              threadUnreadCounts={threadUnreadCounts}
              unfollowThreadById={unfollowThreadById}
              videoReviewContext={videoReviewContextById.get(
                item.entry.message.id,
              )}
            />
          );
      }
    },
    [
      channelId,
      alwaysShowMessageIdentity,
      currentPubkey,
      followThreadById,
      highlightedMessageId,
      openThreadHeadId,
      huddleMemberPubkeys,
      huddleMemberPubkeysPending,
      hideAgentAccessBadges,
      isFollowingThreadById,
      isMessageUnreadById,
      entranceMessageId,
      onEntranceMessageComplete,
      messageFooters,
      onDelete,
      onEdit,
      onMarkRead,
      onMarkUnread,
      onReply,
      onToggleReaction,
      profiles,
      ownerProfiles,
      searchActiveMessageId,
      searchMatchingMessageIds,
      searchQuery,
      threadUnreadCounts,
      unfollowThreadById,
      videoReviewContextById,
    ],
  );

  if (useVirtualizer) {
    return (
      <VirtualizedTimelineRows
        dayGroups={dayGroups}
        historyExhausted={historyExhausted}
        hideDayDividers={hideDayDividers}
        leadingContent={leadingContent}
        onAtBottomStateChange={onAtBottomStateChange}
        onStartReached={onStartReached}
        onVirtualizerApiChange={onVirtualizerApiChange}
        onVirtualizerRangeChanged={onVirtualizerRangeChanged}
        onVirtualizerScrollerChange={onVirtualizerScrollerChange}
        renderItem={renderItem}
      />
    );
  }

  return (
    <div className="flex flex-col">
      {dayGroups.map((group) => (
        <section
          className={cn(
            "relative flex flex-col",
            !hideDayDividers &&
              group.headingTimestamp !== null &&
              "before:absolute before:inset-x-0 before:top-4 before:h-px before:bg-border/35 before:content-['']",
          )}
          data-day-label={
            group.headingTimestamp === null
              ? undefined
              : formatDayHeading(group.headingTimestamp)
          }
          data-testid="message-timeline-day-group"
          key={group.key}
        >
          {hideDayDividers || group.headingTimestamp === null ? null : (
            <DayDivider label={formatDayHeading(group.headingTimestamp)} />
          )}
          {group.items.map((item) => (
            <TimelineRowShell item={item} key={getTimelineItemKey(item)}>
              {renderItem(item)}
            </TimelineRowShell>
          ))}
        </section>
      ))}
    </div>
  );
});

function timelineItemMessageIds(item: TimelineNonDayItem): string[] {
  if (item.kind === "system-group") {
    return item.entries.map((entry) => entry.message.id);
  }
  return item.kind === "message" || item.kind === "system"
    ? [item.entry.message.id]
    : [];
}

type VirtualizedTimelineRowsProps = {
  dayGroups: TimelineDayGroup[];
  historyExhausted: boolean;
  hideDayDividers: boolean;
  leadingContent?: React.ReactNode;
  onAtBottomStateChange?: (
    atBottom: boolean,
    reason: TimelineAtBottomReason,
  ) => void;
  onStartReached?: () => boolean;
  onVirtualizerApiChange?: (api: TimelineVirtualizerApi | null) => void;
  onVirtualizerRangeChanged?: () => void;
  onVirtualizerScrollerChange?: (element: HTMLDivElement | null) => void;
  renderItem: (item: TimelineNonDayItem) => React.ReactNode;
};

type VirtualizedTimelineItemShellProps = {
  children: React.ReactNode;
  index: number;
  ref?: React.LegacyRef<HTMLDivElement>;
  style: React.CSSProperties;
};

const PreserveVirtualizedItemVisibilityContext = React.createContext(false);

function VirtualizedTimelineItemShell({
  children,
  ref,
  style,
}: VirtualizedTimelineItemShellProps) {
  const preserveVisibility = React.useContext(
    PreserveVirtualizedItemVisibilityContext,
  );
  return (
    <div
      ref={ref}
      style={preserveVisibility ? style : { ...style, visibility: undefined }}
    >
      {children}
    </div>
  );
}

function VirtualizedTimelineRows({
  dayGroups,
  historyExhausted,
  hideDayDividers,
  leadingContent,
  onAtBottomStateChange,
  onStartReached,
  onVirtualizerApiChange,
  onVirtualizerRangeChanged,
  onVirtualizerScrollerChange,
  renderItem,
}: VirtualizedTimelineRowsProps) {
  const listRef = React.useRef<VListHandle>(null);
  const hostRef = React.useRef<HTMLDivElement>(null);
  const itemsLengthRef = React.useRef(0);
  const messageItemIndexByIdRef = React.useRef<ReadonlyMap<string, number>>(
    new Map(),
  );
  const hasInitialPositionedRef = React.useRef(false);
  const lastReaderScrollOffsetRef = React.useRef<number | null>(null);
  const programmaticBottomSettleRef = React.useRef(false);
  const programmaticScrollRef = React.useRef(false);
  const userScrollGestureRef = React.useRef(false);
  const estimateCallCountRef = React.useRef(0);
  const estimateItemSize = React.useCallback(
    (item: VirtualizedTimelineItem) => {
      estimateCallCountRef.current += 1;
      const scroller = hostRef.current?.firstElementChild;
      if (scroller instanceof HTMLDivElement) {
        scroller.dataset.virtuaEstimateCallCount = String(
          estimateCallCountRef.current,
        );
      }
      return estimateVirtualizedTimelineItemHeight(item);
    },
    [],
  );
  const items = React.useMemo(
    () =>
      buildVirtualizedItems(
        dayGroups,
        leadingContent,
        historyExhausted,
        !hideDayDividers,
      ),
    [dayGroups, hideDayDividers, historyExhausted, leadingContent],
  );
  const keys = React.useMemo(() => items.map(virtualizedItemKey), [items]);
  const { pinnedDay, pinnedDayLabelRef, updatePinnedDayLabel } =
    useStickyDayDivider({ items, listRef, hostRef });
  itemsLengthRef.current = items.length;
  const previousKeysRef = React.useRef<readonly string[]>([]);
  const hasSeenPrependRef = React.useRef(false);
  const [prependShiftEpoch, clearPrependShift] = React.useReducer(
    (version: number) => version + 1,
    0,
  );
  const { cancel: cancelBottomSettle, settle: settleAtBottom } =
    useVirtualizedBottomSettle(hostRef, listRef, itemsLengthRef);
  const { arm: armUpwardMomentum } = useUpwardPaginationWheel(
    hostRef,
    cancelBottomSettle,
  );

  React.useEffect(
    () => () => {
      cancelBottomSettle();
    },
    [cancelBottomSettle],
  );

  const isPrepend = React.useMemo(() => {
    void prependShiftEpoch;
    return didPrependVirtualizedTimeline(previousKeysRef.current, keys);
  }, [keys, prependShiftEpoch]);
  if (isPrepend) {
    hasSeenPrependRef.current = true;
  }

  React.useLayoutEffect(() => {
    previousKeysRef.current = keys;
    if (isPrepend) {
      clearPrependShift();
    }
    if (!hasInitialPositionedRef.current && items.length > 0) {
      hasInitialPositionedRef.current = true;
      programmaticBottomSettleRef.current = true;
      settleAtBottom();
    }
  }, [isPrepend, items.length, keys, settleAtBottom]);

  const messageItemIndexById = React.useMemo(() => {
    const byId = new Map<string, number>();
    items.forEach((item, index) => {
      if (item.kind !== "timeline-item") return;
      for (const messageId of timelineItemMessageIds(item.item)) {
        byId.set(messageId, index);
      }
    });
    return byId;
  }, [items]);
  messageItemIndexByIdRef.current = messageItemIndexById;

  React.useLayoutEffect(() => {
    const scroller = hostRef.current?.firstElementChild;
    const element = scroller instanceof HTMLDivElement ? scroller : null;
    if (element) {
      element.dataset.buzzConversationScroll = "true";
      element.dataset.testid = "message-timeline";
      element.dataset.virtuaEstimateCallCount = String(
        estimateCallCountRef.current,
      );
    }
    onVirtualizerScrollerChange?.(element);
    if (!element) return;
    const markUserScrollGesture = () => {
      programmaticBottomSettleRef.current = false;
      programmaticScrollRef.current = false;
      userScrollGestureRef.current = true;
    };
    element.addEventListener("pointerdown", markUserScrollGesture, {
      passive: true,
    });
    element.addEventListener("touchstart", markUserScrollGesture, {
      passive: true,
    });
    element.addEventListener("wheel", markUserScrollGesture, {
      passive: true,
    });
    element.addEventListener("keydown", markUserScrollGesture);
    return () => {
      element.removeEventListener("pointerdown", markUserScrollGesture);
      element.removeEventListener("touchstart", markUserScrollGesture);
      element.removeEventListener("wheel", markUserScrollGesture);
      element.removeEventListener("keydown", markUserScrollGesture);
      onVirtualizerScrollerChange?.(null);
    };
  }, [onVirtualizerScrollerChange]);

  React.useLayoutEffect(() => {
    updatePinnedDayLabel(listRef.current?.scrollOffset ?? 0);
  }, [updatePinnedDayLabel]);

  React.useLayoutEffect(() => {
    if (!onVirtualizerApiChange) return;
    const api: TimelineVirtualizerApi = {
      cancelBottomIntent() {
        programmaticBottomSettleRef.current = false;
        programmaticScrollRef.current = false;
        cancelBottomSettle();
      },
      scrollToBottom() {
        programmaticBottomSettleRef.current = true;
        programmaticScrollRef.current = false;
        lastReaderScrollOffsetRef.current = null;
        settleAtBottom();
      },
      settleAtBottom() {
        programmaticBottomSettleRef.current = true;
        programmaticScrollRef.current = false;
        lastReaderScrollOffsetRef.current = null;
        settleAtBottom();
      },
      scrollToMessage(messageId) {
        programmaticBottomSettleRef.current = false;
        programmaticScrollRef.current = true;
        lastReaderScrollOffsetRef.current = null;
        cancelBottomSettle();
        const index = messageItemIndexByIdRef.current.get(messageId);
        if (index === undefined) return false;
        listRef.current?.scrollToIndex(index, { align: "center" });
        return true;
      },
    };
    onVirtualizerApiChange(api);
    return () => onVirtualizerApiChange(null);
  }, [cancelBottomSettle, onVirtualizerApiChange, settleAtBottom]);

  const offscreenBufferSize = useTimelineScrollerResize({
    hasInitialPositionedRef,
    hostRef,
    listRef,
    onAtBottomStateChange,
  });

  const { retainedIndices, onScrollEnd: handleScrollEnd } =
    useTimelineRetention(keys, listRef, isPrepend);

  const handleScroll = React.useCallback(
    (offset: number) => {
      const list = listRef.current;
      const scroller = hostRef.current?.firstElementChild;
      if (!list || !(scroller instanceof HTMLDivElement)) return;
      onVirtualizerRangeChanged?.();
      const distanceFromBottom = list.scrollSize - list.viewportSize - offset;
      if (programmaticBottomSettleRef.current) {
        if (distanceFromBottom <= 32) {
          programmaticBottomSettleRef.current = false;
        }
        lastReaderScrollOffsetRef.current = null;
        userScrollGestureRef.current = false;
      } else if (programmaticScrollRef.current) {
        programmaticScrollRef.current = false;
        lastReaderScrollOffsetRef.current = null;
        userScrollGestureRef.current = false;
      } else if (hasInitialPositionedRef.current && list.viewportSize > 0) {
        const lastReaderOffset = lastReaderScrollOffsetRef.current;
        if (
          distanceFromBottom <= 32 &&
          lastReaderOffset !== null &&
          hasSeenPrependRef.current &&
          !userScrollGestureRef.current &&
          offset > lastReaderOffset + 32
        ) {
          list.scrollTo(lastReaderOffset);
          return;
        }
        if (distanceFromBottom > 32) {
          lastReaderScrollOffsetRef.current = offset;
          cancelBottomSettle();
        } else {
          lastReaderScrollOffsetRef.current = null;
          userScrollGestureRef.current = false;
        }
      }
      // Keep the reader's non-bottom offset until an actual gesture claims it.
      onAtBottomStateChange?.(distanceFromBottom <= 32, "scroll");
      updatePinnedDayLabel(offset);
      if (offset <= 200) {
        // Layout scrolls near the top must not poison the reader's next input.
        armUpwardMomentum(onStartReached?.() ?? false);
      }
    },
    [
      armUpwardMomentum,
      cancelBottomSettle,
      onAtBottomStateChange,
      onStartReached,
      onVirtualizerRangeChanged,
      updatePinnedDayLabel,
    ],
  );

  return (
    <div className="relative h-full min-h-0 w-full" ref={hostRef}>
      <PreserveVirtualizedItemVisibilityContext value={isPrepend}>
        <VList
          ref={listRef}
          className="h-full min-h-0 w-full overflow-y-auto overflow-x-hidden overscroll-contain px-2 pt-[var(--channel-top-chrome-height,4.5rem)]"
          data={items}
          item={VirtualizedTimelineItemShell}
          itemSize={estimateItemSize}
          bufferSize={offscreenBufferSize}
          keepMounted={retainedIndices}
          style={{ overflowAnchor: "none" }}
          shift={isPrepend}
          onScroll={handleScroll}
          onScrollEnd={handleScrollEnd}
        >
          {(item) => {
            if (item.kind === "bottom-spacer") {
              return (
                <div
                  aria-hidden
                  className="h-[var(--composer-overlay-height,6rem)]"
                  key={virtualizedItemKey(item)}
                />
              );
            }
            if (item.kind === "leading-content") {
              return <div key={virtualizedItemKey(item)}>{item.content}</div>;
            }
            if (item.kind === "day-divider") {
              const dayLabel = formatDayHeading(item.headingTimestamp);
              return (
                <div
                  className="relative flex flex-col before:absolute before:inset-x-0 before:top-1/2 before:h-px before:-translate-y-1/2 before:bg-border/35 before:content-['']"
                  data-day-label={dayLabel}
                  data-testid="message-timeline-day-group"
                  key={virtualizedItemKey(item)}
                >
                  <DayDivider label={dayLabel} sticky={false} />
                </div>
              );
            }
            return (
              <TimelineRowShell
                item={item.item}
                key={virtualizedItemKey(item)}
                useContentVisibility={false}
              >
                {renderItem(item.item)}
              </TimelineRowShell>
            );
          }}
        </VList>
      </PreserveVirtualizedItemVisibilityContext>
      <StickyDayDividerOverlay
        pinnedDay={pinnedDay}
        pinnedDayLabelRef={pinnedDayLabelRef}
      />
    </div>
  );
}

function TimelineRowShell({
  children,
  item,
  useContentVisibility = true,
}: {
  children: React.ReactNode;
  item: TimelineNonDayItem;
  useContentVisibility?: boolean;
}) {
  return (
    <div
      className={cn(useContentVisibility && "timeline-row-cv")}
      data-timeline-item-key={getTimelineItemKey(item)}
      style={useContentVisibility ? timelineRowReserveStyle(item) : undefined}
    >
      {children}
    </div>
  );
}

function SystemRow({
  currentPubkey,
  entries,
  entry,
  footer,
  onToggleReaction,
  profiles,
  ownerProfiles,
}: {
  currentPubkey?: string;
  entries?: MainTimelineEntry[];
  entry?: MainTimelineEntry;
  footer: React.ReactNode;
  onToggleReaction?: TimelineMessageListProps["onToggleReaction"];
  profiles?: UserProfileLookup;
  ownerProfiles?: UserProfileLookup;
}) {
  const systemEntries = entries ?? (entry ? [entry] : []);
  const firstEntry = systemEntries[0];
  const groupedMessages = React.useMemo(
    () => entries?.map((systemEntry) => systemEntry.message),
    [entries],
  );
  if (!firstEntry) return null;

  return (
    <div className="flex flex-col gap-1 pb-2.5">
      <SystemMessageRow
        groupedMessages={groupedMessages}
        message={firstEntry.message}
        currentPubkey={currentPubkey}
        onToggleReaction={onToggleReaction}
        profiles={profiles}
        ownerProfiles={ownerProfiles}
      />
      {footer}
    </div>
  );
}

type MessageRowItemProps = Pick<
  TimelineMessageListProps,
  | "channelId"
  | "currentPubkey"
  | "followThreadById"
  | "highlightedMessageId"
  | "openThreadHeadId"
  | "huddleMemberPubkeys"
  | "huddleMemberPubkeysPending"
  | "hideAgentAccessBadges"
  | "isFollowingThreadById"
  | "onDelete"
  | "onEdit"
  | "onMarkUnread"
  | "onMarkRead"
  | "onReply"
  | "onToggleReaction"
  | "profiles"
  | "searchActiveMessageId"
  | "searchMatchingMessageIds"
  | "searchQuery"
  | "threadUnreadCounts"
  | "unfollowThreadById"
> & {
  entry: MainTimelineEntry;
  footer: React.ReactNode;
  isContinuation?: boolean;
  isFollowedByContinuation?: boolean;
  isUnread?: boolean;
  playEntrance?: boolean;
  onEntranceComplete?: (messageId: string) => void;
  videoReviewContext: ReturnType<typeof buildVideoReviewContextForMessage>;
};

function MessageRowItem({
  channelId,
  currentPubkey,
  entry,
  followThreadById,
  footer,
  highlightedMessageId,
  openThreadHeadId,
  huddleMemberPubkeys,
  huddleMemberPubkeysPending,
  hideAgentAccessBadges,
  isContinuation = false,
  isFollowedByContinuation = false,
  isFollowingThreadById,
  isUnread,
  playEntrance = false,
  onEntranceComplete,
  onDelete,
  onEdit,
  onMarkUnread,
  onMarkRead,
  onReply,
  onToggleReaction,
  profiles,
  searchActiveMessageId,
  searchMatchingMessageIds,
  searchQuery,
  threadUnreadCounts,
  unfollowThreadById,
  videoReviewContext,
}: MessageRowItemProps) {
  const { message, summary } = entry;
  const isOpenThreadRoot = message.id === openThreadHeadId;
  const canManage = canManageMessageForCurrentUser(
    message,
    currentPubkey,
    profiles,
  );
  const canDelete = canManage && onDelete ? onDelete : undefined;
  const canEdit = canManage && onEdit ? onEdit : undefined;

  if (summary && onReply) {
    const isHighlighted = message.id === highlightedMessageId;
    return (
      <div
        className={cn(
          "group/message relative mx-1 mb-1 flex flex-col gap-0 rounded-2xl px-0 py-1 transition-colors hover:bg-muted/50 focus-within:bg-muted/50",
          isOpenThreadRoot &&
            "bg-primary/[0.07] ring-1 ring-inset ring-primary/20",
          isHighlighted &&
            "-mx-4 px-4 before:absolute before:-inset-y-1.5 before:inset-x-0 before:animate-[route-target-highlight-fade_2s_ease-out_forwards] before:bg-primary/10 before:content-[''] motion-reduce:before:animate-none sm:-mx-6 sm:px-6",
        )}
      >
        <MessageRow
          channelId={channelId}
          highlighted={false}
          hoverBackground={false}
          huddleMemberPubkeys={huddleMemberPubkeys}
          huddleMemberPubkeysPending={huddleMemberPubkeysPending}
          hideAgentAccessBadge={hideAgentAccessBadges}
          isFollowingThread={
            isFollowingThreadById
              ? isFollowingThreadById(message.id)
              : undefined
          }
          isUnread={isUnread}
          isContinuation={isContinuation}
          playEntrance={playEntrance}
          onEntranceComplete={onEntranceComplete}
          message={message}
          onDelete={canDelete}
          onEdit={canEdit}
          onFollowThread={
            followThreadById ? () => followThreadById(message.id) : undefined
          }
          onMarkRead={onMarkRead}
          onMarkUnread={onMarkUnread}
          onToggleReaction={onToggleReaction}
          onReply={onReply}
          onUnfollowThread={
            unfollowThreadById
              ? () => unfollowThreadById(message.id)
              : undefined
          }
          profiles={profiles}
          showDepthGuides={false}
          videoReviewContext={videoReviewContext}
        />
        <MessageThreadSummaryRow
          depth={message.depth}
          message={message}
          onOpenThread={onReply}
          showDepthGuides={false}
          summary={summary}
          summaryIndentOffsetRem={-THREAD_REPLY_ROW_MARGIN_INLINE_REM}
          unreadCount={threadUnreadCounts?.get(message.id)}
        />
        {footer}
      </div>
    );
  }

  const isSearchMatch = searchMatchingMessageIds?.has(message.id) ?? false;
  const isSearchActive = message.id === searchActiveMessageId;

  return (
    <div
      className={cn(
        "flex flex-col gap-1",
        isFollowedByContinuation ? "pb-0" : "pb-2.5",
      )}
    >
      <MessageRow
        channelId={channelId}
        highlighted={message.id === highlightedMessageId || isSearchActive}
        isOpenThreadRoot={isOpenThreadRoot}
        huddleMemberPubkeys={huddleMemberPubkeys}
        huddleMemberPubkeysPending={huddleMemberPubkeysPending}
        hideAgentAccessBadge={hideAgentAccessBadges}
        isContinuation={isContinuation}
        isUnread={isUnread}
        playEntrance={playEntrance}
        onEntranceComplete={onEntranceComplete}
        message={message}
        onDelete={canDelete}
        onEdit={canEdit}
        onMarkRead={onMarkRead}
        onMarkUnread={onMarkUnread}
        onToggleReaction={onToggleReaction}
        onReply={onReply}
        profiles={profiles}
        searchQuery={isSearchMatch ? searchQuery : undefined}
        showDepthGuides={false}
        videoReviewContext={videoReviewContext}
      />
      {footer}
    </div>
  );
}
