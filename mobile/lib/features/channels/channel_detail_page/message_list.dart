part of '../channel_detail_page.dart';

class _MessageList extends HookConsumerWidget {
  final List<MainTimelineEntry> entries;
  final List<TimelineMessage> allMessages;
  final String? initialMessageId;
  final String? initialThreadRootId;
  final InitialThreadRouteBehavior initialThreadRouteBehavior;
  final String channelId;
  final String? currentPubkey;
  final bool isMember;
  final bool isArchived;
  final double appBarTitleContentHeight;

  const _MessageList({
    required this.entries,
    required this.allMessages,
    required this.initialMessageId,
    required this.initialThreadRootId,
    required this.initialThreadRouteBehavior,
    required this.channelId,
    required this.currentPubkey,
    required this.isMember,
    required this.isArchived,
    required this.appBarTitleContentHeight,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final displayEntries = groupMembershipTimelineEntries(entries);
    final itemScrollController = useMemoized(ItemScrollController.new);
    final itemPositionsListener = useMemoized(ItemPositionsListener.create);
    final stickyDateHeaderState = useValueNotifier(
      StickyDateHeaderState.hidden,
    );
    final stickyDayTimestamp = useValueNotifier<int?>(null);
    final timelineViewportHeight = useRef(MediaQuery.sizeOf(context).height);
    final isLoadingOlder = useState(false);
    final isAtLatest = useState(true);
    final isJumpToLatestVisible = useState(false);
    final hasUserScrolled = useState(false);
    final distanceFromLatest = useRef(0.0);
    final hasUnseenLatestEntry = useRef(false);
    final followsLatest = useRef(
      initialMessageId == null && initialThreadRootId == null,
    );
    final isAutoScrolling = useRef(false);
    final autoScrollScheduled = useRef(false);
    final latestEntryId = entries.isEmpty ? null : entries.last.message.id;
    final previousLatestEntryId = useRef<String?>(null);
    final didOpenInitialThread = useRef(false);
    final didJumpToInitialMessage = useRef(false);

    // The sticky header answers "which day is under the app bar", so it needs
    // the day of every row, the row that opened that day, and which rows are
    // themselves a day header. The list is reversed, so index these by the
    // reversed index the position reports use.
    final dayTimestampByReversedIndex = <int, int>{};
    final dayStartByReversedIndex = <int, int>{};
    final dayHeaderTimestampByReversedIndex = <int, int>{};
    var currentDayTimestamp =
        displayEntries.firstOrNull?.first.message.createdAt;
    var currentDayStartIndex = displayEntries.isEmpty
        ? -1
        : displayEntries.length - 1;
    for (
      var chronologicalIndex = 0;
      chronologicalIndex < displayEntries.length;
      chronologicalIndex += 1
    ) {
      final message = displayEntries[chronologicalIndex].first.message;
      final previousMessage = chronologicalIndex > 0
          ? displayEntries[chronologicalIndex - 1].last.message
          : null;
      final startsDay =
          previousMessage == null ||
          !isSameDay(previousMessage.createdAt, message.createdAt);
      final reversedIndex = displayEntries.length - 1 - chronologicalIndex;
      if (startsDay) {
        currentDayTimestamp = message.createdAt;
        currentDayStartIndex = reversedIndex;
        dayHeaderTimestampByReversedIndex[reversedIndex] = message.createdAt;
      }
      final dayTimestamp = currentDayTimestamp;
      if (dayTimestamp != null) {
        dayTimestampByReversedIndex[reversedIndex] = dayTimestamp;
        dayStartByReversedIndex[reversedIndex] = currentDayStartIndex;
      }
    }

    int? reversedIndexOf(String? messageId) {
      if (messageId == null) return null;
      final chronologicalIndex = displayEntries.indexWhere(
        (group) => group.any((entry) => entry.message.id == messageId),
      );
      return chronologicalIndex < 0
          ? null
          : displayEntries.length - 1 - chronologicalIndex;
    }

    Future<void> scrollToLatest() async {
      if (!itemScrollController.isAttached || isAutoScrolling.value) return;
      followsLatest.value = true;
      hasUserScrolled.value = false;
      hasUnseenLatestEntry.value = false;
      isJumpToLatestVisible.value = false;
      isAutoScrolling.value = true;
      try {
        await itemScrollController.scrollTo(
          index: 0,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
        );
        if (context.mounted && !hasUserScrolled.value) {
          isAtLatest.value = true;
        }
      } finally {
        isAutoScrolling.value = false;
      }
    }

    void scheduleAutoScrollToLatest() {
      if (autoScrollScheduled.value || isAutoScrolling.value) return;
      autoScrollScheduled.value = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        autoScrollScheduled.value = false;
        if (!context.mounted || !followsLatest.value || hasUserScrolled.value) {
          return;
        }
        scrollToLatest();
      });
    }

    bool latestIsAtBoundary() {
      // In this reversed list, item 0's leading edge is the bottom boundary.
      return itemPositionsListener.itemPositions.value.any(
        (position) => position.index == 0 && position.itemLeadingEdge >= 0,
      );
    }

    void updateStickyDateHeader(Iterable<ItemPosition> rawPositions) {
      void setStickyDateHeader(
        StickyDateHeaderState state, {
        int? activeDayTimestamp,
      }) {
        stickyDateHeaderState.value = state;
        stickyDayTimestamp.value = activeDayTimestamp;
      }

      final viewportHeight = timelineViewportHeight.value;
      if (viewportHeight <= 0 || displayEntries.isEmpty) {
        setStickyDateHeader(StickyDateHeaderState.hidden);
        return;
      }

      final positions = rawPositions
          .where(
            (position) =>
                position.index < displayEntries.length &&
                position.itemLeadingEdge < 1 &&
                position.itemTrailingEdge > 0,
          )
          .toList();
      if (positions.isEmpty) {
        if (!isLoadingOlder.value) {
          setStickyDateHeader(StickyDateHeaderState.hidden);
        }
        return;
      }

      final stickyTop =
          frostedAppBarHeight(
            context,
            titleContentHeight: appBarTitleContentHeight,
          ) +
          Grid.twelve;
      double physicalTop(ItemPosition position) =>
          viewportHeight * (1 - position.itemTrailingEdge);
      double physicalBottom(ItemPosition position) =>
          viewportHeight * (1 - position.itemLeadingEdge);

      final positionAtStickyTop = positions
          .where(
            (position) =>
                physicalTop(position) <= stickyTop &&
                physicalBottom(position) > stickyTop,
          )
          .firstOrNull;
      if (positionAtStickyTop == null) {
        if (!isLoadingOlder.value) {
          setStickyDateHeader(StickyDateHeaderState.hidden);
        }
        return;
      }

      final activeDayTimestamp =
          dayTimestampByReversedIndex[positionAtStickyTop.index];
      final activeDayStartIndex =
          dayStartByReversedIndex[positionAtStickyTop.index];
      if (activeDayTimestamp == null || activeDayStartIndex == null) {
        setStickyDateHeader(StickyDateHeaderState.hidden);
        return;
      }

      // Only stand in for a header the timeline has actually scrolled past.
      final activeHeaderPosition = positions
          .where((position) => position.index == activeDayStartIndex)
          .firstOrNull;
      final oldestVisibleIndex = positions
          .map((position) => position.index)
          .reduce((a, b) => a > b ? a : b);
      final activeHeaderHasCrossed = activeHeaderPosition != null
          ? physicalTop(activeHeaderPosition) <= stickyTop
          : activeDayStartIndex > oldestVisibleIndex;
      if (!activeHeaderHasCrossed) {
        setStickyDateHeader(StickyDateHeaderState.hidden);
        return;
      }

      // The next day header coming up pushes the sticky one off the top rather
      // than crossfading two dates in the same place.
      double? nextHeaderTop;
      for (final position in positions) {
        if (!dayHeaderTimestampByReversedIndex.containsKey(position.index) ||
            position.index >= activeDayStartIndex) {
          continue;
        }
        final top = physicalTop(position);
        if (top <= stickyTop ||
            (nextHeaderTop != null && top >= nextHeaderTop)) {
          continue;
        }
        nextHeaderTop = top;
      }

      final stickyHeaderHeight = StickyDateHeader.heightOf(context);
      final rawTranslateY = nextHeaderTop == null
          ? 0.0
          : min(0.0, nextHeaderTop - stickyTop - stickyHeaderHeight - 5);
      final translateY = rawTranslateY
          .clamp(-(stickyHeaderHeight + 5), 0.0)
          .toDouble();
      setStickyDateHeader(
        StickyDateHeaderState(
          label: formatDayHeading(activeDayTimestamp),
          // Half-pixel quantisation: position reports arrive far more often
          // than the header can meaningfully move.
          translateY: (translateY * 2).round() / 2,
        ),
        activeDayTimestamp: activeDayTimestamp,
      );
    }

    void updateJumpToLatestVisibility(
      Iterable<ItemPosition> positions, {
      double? viewportDimension,
    }) {
      final latestIsVisible = positions.any(
        (position) =>
            position.index == 0 &&
            position.itemLeadingEdge < 1 &&
            position.itemTrailingEdge > 0,
      );
      final viewportHeight = viewportDimension ?? timelineViewportHeight.value;
      final visiblePageHeight = max(
        0.0,
        viewportHeight -
            frostedAppBarHeight(
              context,
              titleContentHeight: appBarTitleContentHeight,
            ),
      );
      // Showing it for any scroll at all would make it permanent furniture.
      // It earns its place when the newest message is off screen, more than a
      // page away, or has arrived unseen.
      final shouldShow =
          !latestIsAtBoundary() &&
          (hasUnseenLatestEntry.value ||
              !latestIsVisible ||
              distanceFromLatest.value > visiblePageHeight);
      if (isJumpToLatestVisible.value != shouldShow) {
        isJumpToLatestVisible.value = shouldShow;
      }
    }

    useEffect(
      () {
        void onPositionsChanged() {
          final positions = itemPositionsListener.itemPositions.value;
          if (positions.isEmpty) return;
          updateStickyDateHeader(positions);
          updateJumpToLatestVisibility(positions);
          final nextIsAtLatest = latestIsAtBoundary();
          if (nextIsAtLatest) {
            hasUnseenLatestEntry.value = false;
            if (isJumpToLatestVisible.value) {
              isJumpToLatestVisible.value = false;
            }
            if (!isAtLatest.value) isAtLatest.value = true;
          } else if (followsLatest.value && !hasUserScrolled.value) {
            // The viewport can shrink when the composer or keyboard opens.
            // Preserve auto-follow until the user scrolls the timeline.
            if (!isAtLatest.value) isAtLatest.value = true;
            scheduleAutoScrollToLatest();
          } else if (isAtLatest.value) {
            isAtLatest.value = false;
          }

          final oldestVisible = positions
              .map((position) => position.index)
              .reduce((a, b) => a > b ? a : b);
          if (!hasUserScrolled.value ||
              oldestVisible < displayEntries.length - 3 ||
              isLoadingOlder.value) {
            return;
          }
          final notifier = ref.read(
            channelMessagesProvider(channelId).notifier,
          );
          if (notifier.reachedOldest) return;
          isLoadingOlder.value = true;
          notifier.fetchOlder().whenComplete(
            () => isLoadingOlder.value = false,
          );
        }

        var disposed = false;
        itemPositionsListener.itemPositions.addListener(onPositionsChanged);
        // Positions do not change on a first layout that already sits at the
        // tail, so evaluate once rather than waiting for a scroll.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!disposed && context.mounted) onPositionsChanged();
        });
        return () {
          disposed = true;
          itemPositionsListener.itemPositions.removeListener(
            onPositionsChanged,
          );
        };
      },
      [
        channelId,
        entries.length,
        itemPositionsListener,
        appBarTitleContentHeight,
      ],
    );

    useEffect(() {
      stickyDateHeaderState.value = StickyDateHeaderState.hidden;
      stickyDayTimestamp.value = null;
      return null;
    }, [channelId]);

    useEffect(() {
      if (initialThreadRootId == null || didOpenInitialThread.value) {
        return null;
      }
      final threadHead = allMessages
          .where((message) => message.id == initialThreadRootId)
          .firstOrNull;
      if (threadHead == null) return null;
      didOpenInitialThread.value = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        // A route that is no longer current has already been navigated away
        // from; pushing onto it would resurrect a dead branch of the stack.
        if (!context.mounted || ModalRoute.of(context)?.isCurrent != true) {
          return;
        }
        final route = MaterialPageRoute<void>(
          builder: (_) => ThreadDetailPage(
            threadHead: threadHead,
            allMessages: allMessages,
            channelId: channelId,
            currentPubkey: currentPubkey,
            isMember: isMember,
            isArchived: isArchived,
            initialMessageId: initialMessageId,
          ),
        );
        final navigator = Navigator.of(context);
        switch (initialThreadRouteBehavior) {
          case InitialThreadRouteBehavior.push:
            navigator.push(route);
          case InitialThreadRouteBehavior.replaceCurrentRoute:
            navigator.pushReplacement(route);
        }
      });
      return null;
    }, [initialThreadRootId, allMessages, initialThreadRouteBehavior]);

    useEffect(() {
      final targetIndex = reversedIndexOf(initialMessageId);
      if (initialThreadRootId != null ||
          targetIndex == null ||
          didJumpToInitialMessage.value) {
        return null;
      }
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!context.mounted || !itemScrollController.isAttached) return;
        didJumpToInitialMessage.value = true;
        followsLatest.value = false;
        hasUserScrolled.value = false;
        isAtLatest.value = false;
        itemScrollController.jumpTo(index: targetIndex, alignment: 0.35);
      });
      return null;
    }, [initialMessageId, initialThreadRootId, entries.length]);

    useEffect(() {
      final previous = previousLatestEntryId.value;
      previousLatestEntryId.value = latestEntryId;
      if (previous == null ||
          latestEntryId == null ||
          previous == latestEntryId) {
        return null;
      }
      if (!isAtLatest.value) {
        // A message the user has not been carried down to is what makes the
        // control worth showing even a short scroll from the tail.
        hasUnseenLatestEntry.value = true;
      }
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!context.mounted) return;
        if (isAtLatest.value) {
          scrollToLatest();
          return;
        }
        final positions = itemPositionsListener.itemPositions.value;
        if (positions.isNotEmpty) {
          if (latestIsAtBoundary()) hasUnseenLatestEntry.value = false;
          updateJumpToLatestVisibility(positions);
        }
      });
      return null;
    }, [latestEntryId]);

    if (entries.isEmpty) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              LucideIcons.messageSquare,
              size: Grid.xl,
              color: context.colors.onSurfaceVariant,
            ),
            const SizedBox(height: Grid.xxs),
            Text(
              'No messages yet',
              style: context.textTheme.bodyLarge?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: Grid.half),
            Text(
              'Be the first to say something!',
              style: context.textTheme.bodySmall?.copyWith(
                color: context.colors.onSurfaceVariant,
              ),
            ),
          ],
        ),
      );
    }

    // Build channel names map once for all message bubbles.
    final channelsAsync = ref.watch(channelsProvider);
    final channelNamesMap = <String, String>{};
    channelsAsync.whenData((channels) {
      for (final ch in channels) {
        channelNamesMap[ch.name.toLowerCase()] = ch.id;
      }
    });

    return Stack(
      children: [
        NotificationListener<Notification>(
          onNotification: (notification) {
            // Inner scrollables (a code block, a horizontal attachment strip)
            // must not be mistaken for the timeline's own metrics.
            if (notification is ScrollMetricsNotification &&
                notification.depth != 0) {
              return false;
            }
            if (notification is ScrollNotification && notification.depth != 0) {
              return false;
            }
            if (notification is ScrollMetricsNotification) {
              timelineViewportHeight.value =
                  notification.metrics.viewportDimension;
              return false;
            }
            if (notification is! ScrollNotification) return false;
            timelineViewportHeight.value =
                notification.metrics.viewportDimension;
            distanceFromLatest.value = max(
              0.0,
              notification.metrics.pixels -
                  notification.metrics.minScrollExtent,
            );
            updateJumpToLatestVisibility(
              itemPositionsListener.itemPositions.value,
              viewportDimension: notification.metrics.viewportDimension,
            );
            if (notification is UserScrollNotification &&
                notification.direction != ScrollDirection.idle) {
              hasUserScrolled.value = true;
              followsLatest.value = false;
            } else if (notification is ScrollEndNotification &&
                hasUserScrolled.value) {
              WidgetsBinding.instance.addPostFrameCallback((_) {
                if (!context.mounted || !latestIsAtBoundary()) return;
                hasUserScrolled.value = false;
                followsLatest.value = true;
                if (!isAtLatest.value) isAtLatest.value = true;
              });
            }
            return false;
          },
          child: ScrollablePositionedList.builder(
            key: const ValueKey('channel-message-list'),
            itemScrollController: itemScrollController,
            itemPositionsListener: itemPositionsListener,
            reverse: true,
            padding: EdgeInsets.only(
              left: Grid.gutter,
              right: Grid.gutter,
              top: frostedAppBarHeight(
                context,
                titleContentHeight: appBarTitleContentHeight,
              ),
              bottom: 0,
            ),
            itemCount: displayEntries.length + (isLoadingOlder.value ? 1 : 0),
            itemBuilder: (context, index) {
              // Loading indicator at the top (last index in reversed list).
              if (index >= displayEntries.length) {
                return const Padding(
                  padding: EdgeInsets.symmetric(vertical: Grid.xs),
                  child: Center(
                    child: ColonyLoadingIndicator(
                      size: 24,
                      semanticLabel: 'Loading older messages',
                    ),
                  ),
                );
              }

              // Reversed list: index 0 = newest (bottom of screen).
              final chronIdx = displayEntries.length - 1 - index;
              final entryGroup = displayEntries[chronIdx];
              final entry = entryGroup.first;
              final message = entry.message;

              // Day boundary check — applies to all messages including system.
              final prevEntry = chronIdx > 0
                  ? displayEntries[chronIdx - 1].last
                  : null;
              final prevMessage = prevEntry?.message;
              final showDayDivider =
                  prevMessage == null ||
                  !isSameDay(prevMessage.createdAt, message.createdAt);

              final showAuthor =
                  !message.isSystem &&
                  (message.hasAttachments ||
                      prevMessage == null ||
                      prevMessage.isSystem ||
                      showDayDivider ||
                      prevMessage.pubkey.toLowerCase() !=
                          message.pubkey.toLowerCase() ||
                      (message.createdAt - prevMessage.createdAt) > 300);

              return Padding(
                key: ValueKey('channel-message-group-${message.id}'),
                padding: EdgeInsets.only(bottom: index == 0 ? Grid.xs : 0),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (showDayDivider)
                      DayDivider(
                        label: formatDayHeading(message.createdAt),
                        dayTimestamp: message.createdAt,
                        stickyDayTimestamp: stickyDayTimestamp,
                      ),
                    if (message.isSystem)
                      _SystemMessageRow(
                        message: message,
                        groupedMessages: entryGroup.length > 1
                            ? entryGroup.map((entry) => entry.message).toList()
                            : null,
                        channelId: channelId,
                        currentPubkey: currentPubkey,
                        allMessages: null,
                        isMember: isMember,
                        isArchived: isArchived,
                      )
                    else ...[
                      _MessageBubble(
                        message: message,
                        showAuthor: showAuthor,
                        channelNames: channelNamesMap,
                        currentChannelId: channelId,
                        currentPubkey: currentPubkey,
                        allMessages: allMessages,
                        isMember: isMember,
                        isArchived: isArchived,
                      ),
                      if (entry.summary != null)
                        _ThreadSummaryRow(
                          summary: entry.summary!,
                          message: message,
                          allMessages: allMessages,
                          channelId: channelId,
                          currentPubkey: currentPubkey,
                          isMember: isMember,
                          isArchived: isArchived,
                        ),
                    ],
                  ],
                ),
              );
            },
          ),
        ),
        Positioned(
          left: 0,
          right: 0,
          top:
              frostedAppBarHeight(
                context,
                titleContentHeight: appBarTitleContentHeight,
              ) +
              Grid.twelve,
          child: StickyDateHeader(
            key: const ValueKey('channel-sticky-date-header'),
            state: stickyDateHeaderState,
          ),
        ),
        Positioned(
          left: 0,
          right: 0,
          bottom: Grid.xs,
          child: Center(
            child: AnimatedSwitcher(
              key: const ValueKey('channel-jump-to-latest-switcher'),
              duration: MediaQuery.disableAnimationsOf(context)
                  ? Duration.zero
                  : const Duration(milliseconds: 180),
              reverseDuration: MediaQuery.disableAnimationsOf(context)
                  ? Duration.zero
                  : const Duration(milliseconds: 160),
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              transitionBuilder: (child, animation) => FadeTransition(
                opacity: animation,
                child: ScaleTransition(
                  scale: _JumpToLatestScaleAnimation(animation),
                  alignment: Alignment.bottomCenter,
                  child: child,
                ),
              ),
              child: !isJumpToLatestVisible.value
                  ? const SizedBox.shrink(
                      key: ValueKey('channel-jump-to-latest-hidden'),
                    )
                  : JumpToLatestButton(
                      key: const ValueKey('channel-jump-to-latest'),
                      onPressed: scrollToLatest,
                    ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Scales the jump-to-latest control from its bottom-center anchor.
///
/// Entering starts at 92% so the control grows out of the anchor; leaving
/// tracks the fade directly so it shrinks away rather than snapping.
class _JumpToLatestScaleAnimation extends Animation<double>
    with AnimationWithParentMixin<double> {
  @override
  final Animation<double> parent;

  _JumpToLatestScaleAnimation(this.parent);

  @override
  double get value => parent.status == AnimationStatus.reverse
      ? parent.value
      : 0.92 + (0.08 * parent.value);
}
