import * as React from "react";
import type { VListHandle } from "virtua";

import { formatDayHeading } from "@/features/messages/lib/dateFormatters";
import type { VirtualizedTimelineItem } from "@/features/messages/lib/virtualizedTimelineItems";
import { cn } from "@/shared/lib/cn";
import { channelChrome } from "@/shared/layout/chromeLayout";
import { DayDivider } from "./DayDivider";
import { activeDayDividerIndex } from "./stickyDayDivider";

type StickyDayDividerArgs = {
  items: VirtualizedTimelineItem[];
  listRef: React.RefObject<VListHandle | null>;
  hostRef: React.RefObject<HTMLDivElement | null>;
};

type DayDividerItem = Extract<VirtualizedTimelineItem, { kind: "day-divider" }>;

export function useStickyDayDivider({
  items,
  listRef,
  hostRef,
}: StickyDayDividerArgs) {
  const dayDividerItems = React.useMemo(
    () =>
      items.flatMap((item, index) =>
        item.kind === "day-divider" ? [{ index, item }] : [],
      ),
    [items],
  );
  const pinnedDayLabelRef = React.useRef<HTMLDivElement>(null);
  const pinnedDayTranslateYRef = React.useRef(0);
  const [pinnedDay, setPinnedDay] = React.useState<{
    label: string | null;
    incomingLabel: string | null;
  }>({ label: null, incomingLabel: null });

  const updatePinnedDayLabel = React.useCallback(
    (offset: number) => {
      const list = listRef.current;
      const scroller = hostRef.current?.firstElementChild;
      const pinnedLabel = pinnedDayLabelRef.current;
      if (!list || !(scroller instanceof HTMLDivElement) || !pinnedLabel) {
        return;
      }

      const pinnedTop =
        pinnedLabel.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        pinnedDayTranslateYRef.current;
      const [pinnedPill, incomingPinnedPill] =
        pinnedLabel.querySelectorAll<HTMLParagraphElement>("p");
      const pinnedPillHeight = pinnedPill?.offsetHeight ?? 0;
      if (pinnedPillHeight === 0) return;

      const renderedDividerPillTop = (divider: { item: DayDividerItem }) => {
        const label = formatDayHeading(divider.item.headingTimestamp);
        const source = [
          ...scroller.querySelectorAll<HTMLElement>(
            '[data-testid="message-timeline-day-divider"]',
          ),
        ].find((element) => element.dataset.dayLabel === label);
        const pill = source?.querySelector<HTMLElement>("p");
        return pill
          ? pill.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top
          : null;
      };
      const sourcePills = [
        ...scroller.querySelectorAll<HTMLElement>(
          '[data-testid="message-timeline-day-divider"] p',
        ),
      ];
      for (const pill of sourcePills) pill.style.removeProperty("visibility");

      let candidateIndex = -1;
      for (const [index, divider] of dayDividerItems.entries()) {
        if (list.getItemOffset(divider.index) > offset + pinnedTop) break;
        candidateIndex = index;
      }
      const candidateDivider = dayDividerItems[candidateIndex];
      const activeDividerIndex = activeDayDividerIndex({
        scrollOffset: offset,
        candidateIndex,
        candidatePillTop: candidateDivider
          ? renderedDividerPillTop(candidateDivider)
          : null,
        pinnedTop,
      });
      const activeDivider = dayDividerItems[activeDividerIndex];
      // Nothing pinned means nothing in transit either. Without this guard the
      // divider that is merely NEXT would still be pulled into the incoming
      // slot at the top of the timeline, hiding the real one and drawing its
      // own copy over the first message: the same overlap by another route.
      const nextDivider =
        activeDividerIndex < 0
          ? undefined
          : dayDividerItems[activeDividerIndex + 1];
      const nextDividerTop = nextDivider
        ? (renderedDividerPillTop(nextDivider) ??
          list.getItemOffset(nextDivider.index) - offset)
        : null;
      const nextTranslateY =
        nextDividerTop === null
          ? 0
          : Math.max(
              -pinnedPillHeight,
              Math.min(0, nextDividerTop - pinnedTop - pinnedPillHeight),
            );
      if (pinnedDayTranslateYRef.current !== nextTranslateY) {
        pinnedDayTranslateYRef.current = nextTranslateY;
        pinnedLabel.style.transform = `translateY(${nextTranslateY}px)`;
      }
      const nextLabel = activeDivider
        ? formatDayHeading(activeDivider.item.headingTimestamp)
        : null;
      const incomingLabel =
        nextDivider && nextTranslateY < 0
          ? formatDayHeading(nextDivider.item.headingTimestamp)
          : null;
      const activeSourcePill = sourcePills.find(
        (pill) => pill.parentElement?.dataset.dayLabel === nextLabel,
      );
      if (activeSourcePill) {
        const sourceTop =
          activeSourcePill.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top;
        const sourceBottom = sourceTop + activeSourcePill.offsetHeight;
        const overlayBottom = pinnedTop + pinnedPillHeight;
        if (sourceBottom > pinnedTop && sourceTop < overlayBottom) {
          activeSourcePill.style.visibility = "hidden";
        }
      }
      const incomingSourcePill = sourcePills.find(
        (pill) => pill.parentElement?.dataset.dayLabel === incomingLabel,
      );
      if (incomingSourcePill) incomingSourcePill.style.visibility = "hidden";
      if (pinnedPill) {
        pinnedPill.textContent = nextLabel ?? "";
        pinnedPill.style.visibility = nextLabel ? "visible" : "hidden";
      }
      if (incomingPinnedPill) {
        incomingPinnedPill.textContent = incomingLabel ?? "";
        incomingPinnedPill.style.visibility = incomingLabel
          ? "visible"
          : "hidden";
      }
      setPinnedDay((current) =>
        current.label === nextLabel && current.incomingLabel === incomingLabel
          ? current
          : { label: nextLabel, incomingLabel },
      );
    },
    [dayDividerItems, hostRef, listRef],
  );

  React.useLayoutEffect(() => {
    updatePinnedDayLabel(listRef.current?.scrollOffset ?? 0);
  }, [listRef, updatePinnedDayLabel]);

  return { pinnedDay, pinnedDayLabelRef, updatePinnedDayLabel };
}

export function StickyDayDividerOverlay({
  pinnedDay,
  pinnedDayLabelRef,
}: {
  pinnedDay: { label: string | null; incomingLabel: string | null };
  pinnedDayLabelRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0 z-20",
        channelChrome.stickyTimelineTop,
        pinnedDay.label || pinnedDay.incomingLabel
          ? "opacity-100"
          : "opacity-0",
      )}
      data-day-label={pinnedDay.label ?? undefined}
      data-testid="message-timeline-sticky-day-divider"
    >
      <div className="invisible flex justify-center">
        <DayDivider label={pinnedDay.label ?? ""} sticky={false} testId="" />
      </div>
      <div
        className="absolute inset-x-0 top-0 flex flex-col"
        data-testid="message-timeline-sticky-day-divider-content"
        ref={pinnedDayLabelRef}
      >
        <DayDivider label={pinnedDay.label ?? ""} sticky={false} testId="" />
        <DayDivider
          label={pinnedDay.incomingLabel ?? ""}
          sticky={false}
          testId=""
        />
      </div>
    </div>
  );
}
