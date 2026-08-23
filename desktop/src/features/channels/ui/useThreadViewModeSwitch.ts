import * as React from "react";

import {
  setThreadViewMode,
  type ThreadViewMode,
} from "@/features/channels/lib/threadViewModePreference";
import { subscribeBeforeChannelSurfaceModeChange } from "@/features/workspace/lib/channelSurfaceMode";

export function findTopVisibleThreadMessageId(
  body: HTMLElement | null,
): string | null {
  if (!body) return null;

  const bodyTop = body.getBoundingClientRect().top;
  const visibleReply = Array.from(
    body.querySelectorAll<HTMLElement>("[data-message-id]"),
  ).find((row) => row.getBoundingClientRect().bottom > bodyTop);
  return visibleReply?.dataset.messageId ?? null;
}

export function getResolvedThreadTargets({
  externalTargetId,
  layoutTargetId,
}: {
  externalTargetId: string | null;
  layoutTargetId: string | null;
}) {
  return {
    resolveExternal:
      layoutTargetId === null || layoutTargetId === externalTargetId,
    resolveLayout: layoutTargetId !== null,
  };
}

type LayoutScrollTarget = {
  channelId: string;
  messageId: string;
  topOffsetPx: number;
  threadHeadId: string;
};

export function getLayoutScrollTarget(
  body: HTMLElement | null,
  threadHeadId: string | null,
  channelId: string | null,
): LayoutScrollTarget | null {
  if (!body || !threadHeadId || !channelId) return null;
  const messageId = findTopVisibleThreadMessageId(body);
  if (!messageId) return null;
  const row = Array.from(
    body.querySelectorAll<HTMLElement>("[data-message-id]"),
  ).find((candidate) => candidate.dataset.messageId === messageId);
  return row
    ? {
        channelId,
        messageId,
        threadHeadId,
        topOffsetPx:
          row.getBoundingClientRect().top - body.getBoundingClientRect().top,
      }
    : null;
}

export function restoreLayoutScrollTargetOffset(
  body: HTMLElement | null,
  target: LayoutScrollTarget | null,
): boolean {
  if (!body || !target) return false;
  const row = Array.from(
    body.querySelectorAll<HTMLElement>("[data-message-id]"),
  ).find((candidate) => candidate.dataset.messageId === target.messageId);
  if (!row) return false;
  body.scrollTop += getLayoutScrollOffsetDelta(body, row, target.topOffsetPx);
  return true;
}

export function getLayoutScrollOffsetDelta(
  body: Pick<HTMLElement, "getBoundingClientRect">,
  row: Pick<HTMLElement, "getBoundingClientRect">,
  topOffsetPx: number,
): number {
  return (
    row.getBoundingClientRect().top -
    body.getBoundingClientRect().top -
    topOffsetPx
  );
}

export function getScopedLayoutScrollTargetId({
  activeThreadHeadId,
  channelId,
  layoutTarget,
}: {
  activeThreadHeadId: string | null;
  channelId: string | null;
  layoutTarget: LayoutScrollTarget | null;
}): string | null {
  return layoutTarget?.channelId === channelId &&
    layoutTarget.threadHeadId === activeThreadHeadId
    ? layoutTarget.messageId
    : null;
}

type ThreadViewModeSwitchOptions = {
  activeThreadHeadId: string | null;
  channelId: string | null;
  externalScrollTargetId: string | null;
  onExternalTargetResolved: () => void;
  onModeChange?: (mode: ThreadViewMode) => void;
};

/** Preserves the reply being read while the thread changes presentation. */
export function useThreadViewModeSwitch({
  activeThreadHeadId,
  channelId,
  externalScrollTargetId,
  onExternalTargetResolved,
  onModeChange,
}: ThreadViewModeSwitchOptions) {
  const [layoutScrollTarget, setLayoutScrollTarget] =
    React.useState<LayoutScrollTarget | null>(null);
  const layoutRestoreTokenRef = React.useRef(0);
  const activeScopeRef = React.useRef({ activeThreadHeadId, channelId });
  activeScopeRef.current = { activeThreadHeadId, channelId };
  const layoutScrollTargetId = getScopedLayoutScrollTargetId({
    activeThreadHeadId,
    channelId,
    layoutTarget: layoutScrollTarget,
  });

  React.useEffect(() => {
    layoutRestoreTokenRef.current += 1;
    setLayoutScrollTarget((current) =>
      current?.channelId === channelId &&
      current.threadHeadId === activeThreadHeadId
        ? current
        : null,
    );
  }, [activeThreadHeadId, channelId]);

  React.useEffect(
    () => () => {
      layoutRestoreTokenRef.current += 1;
    },
    [],
  );

  const preserveThreadScrollPosition = React.useCallback(() => {
    const body = document.querySelector<HTMLElement>(
      '[data-testid="message-thread-body"]',
    );
    const target = getLayoutScrollTarget(body, activeThreadHeadId, channelId);
    const token = layoutRestoreTokenRef.current + 1;
    layoutRestoreTokenRef.current = token;
    setLayoutScrollTarget(null);
    if (!body || !target || !channelId) return;

    let remainingFrames = 24;
    let settledFrames = 0;
    const restoreAfterLayout = () => {
      requestAnimationFrame(() => {
        const scope = activeScopeRef.current;
        if (
          layoutRestoreTokenRef.current !== token ||
          scope.channelId !== channelId ||
          scope.activeThreadHeadId !== target.threadHeadId ||
          document.querySelector('[data-testid="message-thread-body"]') !== body
        ) {
          return;
        }

        const row = Array.from(
          body.querySelectorAll<HTMLElement>("[data-message-id]"),
        ).find((candidate) => candidate.dataset.messageId === target.messageId);
        if (!row) {
          setLayoutScrollTarget(target);
          return;
        }

        const delta = getLayoutScrollOffsetDelta(body, row, target.topOffsetPx);
        if (Math.abs(delta) <= 0.5) {
          settledFrames += 1;
        } else {
          body.scrollTop += delta;
          settledFrames = 0;
        }

        remainingFrames -= 1;
        if (remainingFrames > 0 && settledFrames < 3) restoreAfterLayout();
      });
    };
    restoreAfterLayout();
  }, [activeThreadHeadId, channelId]);

  React.useEffect(() => {
    if (!channelId) return;
    return subscribeBeforeChannelSurfaceModeChange((change) => {
      if (change.channelId === channelId) preserveThreadScrollPosition();
    });
  }, [channelId, preserveThreadScrollPosition]);

  const changeThreadViewMode = React.useCallback(
    (mode: ThreadViewMode, restoreFocus: boolean) => {
      preserveThreadScrollPosition();
      onModeChange?.(mode);
      setThreadViewMode(mode);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(
              restoreFocus
                ? '[data-testid="thread-view-mode-toggle"]'
                : '[data-testid="message-thread-body"]',
            )
            ?.focus({ preventScroll: true });
        });
      });
    },
    [onModeChange, preserveThreadScrollPosition],
  );

  const resolveScrollTarget = React.useCallback(
    (settledMessageId?: string) => {
      const resolution = getResolvedThreadTargets({
        externalTargetId: externalScrollTargetId,
        layoutTargetId: layoutScrollTargetId,
      });
      if (resolution.resolveExternal) onExternalTargetResolved();
      if (
        settledMessageId &&
        layoutScrollTarget?.threadHeadId === activeThreadHeadId &&
        layoutScrollTarget.messageId === settledMessageId
      ) {
        restoreLayoutScrollTargetOffset(
          document.querySelector<HTMLElement>(
            '[data-testid="message-thread-body"]',
          ),
          layoutScrollTarget,
        );
      }
      if (settledMessageId) {
        setLayoutScrollTarget((current) =>
          current?.threadHeadId === activeThreadHeadId &&
          current.messageId === settledMessageId
            ? null
            : current,
        );
      }
    },
    [
      activeThreadHeadId,
      externalScrollTargetId,
      layoutScrollTarget,
      layoutScrollTargetId,
      onExternalTargetResolved,
    ],
  );

  return {
    changeThreadViewMode,
    layoutScrollTargetId,
    resolveScrollTarget,
  };
}
