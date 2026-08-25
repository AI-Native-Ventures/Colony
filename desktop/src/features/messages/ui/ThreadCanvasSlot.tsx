import { cn } from "@/shared/lib/cn";
import { THREAD_PANEL_MESSAGE_GUTTER_CLASS } from "@/features/messages/lib/messageThreadPanelLayout";
import { ThreadCanvasPanel } from "./ThreadCanvasPanel";

type ThreadCanvasSlotProps = {
  canEdit: boolean;
  /** Huddle transcripts and DMs carry no thread canvas. */
  hidden: boolean;
  /**
   * Channel and level-1 root as one prop. Bundled because the caller,
   * MessageThreadPanel, sits one line under the desktop file size ratchet and
   * a fifth prop line would push it over. Safe here: this component is not
   * memoized, so the fresh object costs nothing.
   */
  thread: { channelId: string | null; rootId: string };
};

/**
 * Gutter wrapper deciding whether this thread gets a canvas at all.
 *
 * Split out of `MessageThreadPanel` so the surface that owns it stays under the
 * desktop file size ratchet, and so the "which threads have a canvas" rule sits
 * next to the panel rather than buried in the timeline's render tree.
 */
export function ThreadCanvasSlot({
  canEdit,
  hidden,
  thread,
}: ThreadCanvasSlotProps) {
  if (hidden) {
    return null;
  }
  return (
    <div className={cn(THREAD_PANEL_MESSAGE_GUTTER_CLASS, "pb-2 pt-3")}>
      <ThreadCanvasPanel
        canEdit={canEdit}
        channelId={thread.channelId}
        threadRootId={thread.rootId}
      />
    </div>
  );
}
