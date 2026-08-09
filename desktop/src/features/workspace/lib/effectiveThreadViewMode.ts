import {
  type ThreadViewMode,
  useThreadViewMode,
} from "@/features/channels/lib/threadViewModePreference";
import {
  type ChannelSurfaceMode,
  useChannelSurfaceMode,
} from "@/features/workspace/lib/channelSurfaceMode";

/**
 * How a thread should open, given the user's preference and the channel's
 * current surface.
 *
 * `focus` is an overlay drawer across the content column. Overlaying the
 * workspace would hide the surface the user just chose, so workspace mode
 * forces `split`. This is a pure override: the stored preference is untouched
 * and applies again the moment the channel returns to the timeline.
 */
export function effectiveThreadViewMode(
  preference: ThreadViewMode,
  surfaceMode: ChannelSurfaceMode,
): ThreadViewMode {
  return surfaceMode === "workspace" ? "split" : preference;
}

/** The thread view mode a channel should actually use right now. */
export function useEffectiveThreadViewMode(
  channelId: string | undefined,
): ThreadViewMode {
  return effectiveThreadViewMode(
    useThreadViewMode(),
    useChannelSurfaceMode(channelId),
  );
}
