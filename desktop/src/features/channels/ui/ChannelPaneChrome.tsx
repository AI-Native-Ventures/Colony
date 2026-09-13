import type { useChannelFind } from "@/features/search/useChannelFind";
import { ChannelFindBar } from "@/features/search/ui/ChannelFindBar";
import { cn } from "@/shared/lib/cn";

/**
 * Chrome that floats above the channel pane's own content: the shared header
 * blur strip and the find bar. Split out of `ChannelPane.tsx` so that file
 * stays under the desktop file-size ratchet; both are pure presentation and
 * carry no pane state of their own.
 */
export function ChannelSharedHeaderBackdrop({
  heightClassName,
  visible,
}: {
  heightClassName: string;
  visible: boolean;
}) {
  if (!visible) return null;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-30 bg-background/80 backdrop-blur-md supports-backdrop-filter:bg-background/70 dark:bg-background/70 dark:backdrop-blur-xl dark:supports-backdrop-filter:bg-background/55",
        heightClassName,
      )}
      data-testid="channel-shared-header-backdrop"
    />
  );
}

export function ChannelFindBarSlot({
  find,
  topClassName,
}: {
  find: ReturnType<typeof useChannelFind>;
  topClassName: string;
}) {
  if (!find.isOpen) return null;
  return (
    <div className={cn("absolute inset-x-0 z-40", topClassName)}>
      <ChannelFindBar
        matchCount={find.matchCount}
        matchIndex={find.activeIndex}
        onClose={find.close}
        onNext={find.goToNext}
        onPrevious={find.goToPrevious}
        onQueryChange={find.setQuery}
        query={find.query}
      />
    </div>
  );
}
