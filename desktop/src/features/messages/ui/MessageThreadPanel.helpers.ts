import type { MainTimelineEntry } from "@/features/messages/lib/threadPanel";
import type { TimelineMessage } from "@/features/messages/types";

export { summarizeThreadRoot } from "@/features/messages/lib/sentFromThread";

/** Whether another visible entry at the same depth follows this one. */
export function hasLaterVisibleSibling(
  entries: readonly MainTimelineEntry[],
  entryIndex: number,
): boolean {
  const depth = entries[entryIndex]?.message.depth;
  if (depth == null) {
    return false;
  }

  for (let index = entryIndex + 1; index < entries.length; index += 1) {
    const nextDepth = entries[index].message.depth;
    if (nextDepth <= depth) {
      return nextDepth === depth;
    }
  }

  return false;
}

/** Depths of ancestor branches whose continuation lines are still visible. */
export function getActiveContinuationDepths({
  ancestors,
  entries,
  index,
  message,
}: {
  ancestors: readonly { index: number; message: TimelineMessage }[];
  entries: readonly MainTimelineEntry[];
  index: number;
  message: TimelineMessage;
}): number[] {
  const depths: number[] = [];

  for (const ancestor of ancestors) {
    if (ancestor.message.depth === 0) {
      continue;
    }

    const childDepth = ancestor.message.depth + 1;
    const pathChild =
      message.depth === childDepth
        ? { index, message }
        : ancestors.find((candidate) => candidate.message.depth === childDepth);

    if (pathChild && hasLaterVisibleSibling(entries, pathChild.index)) {
      depths.push(ancestor.message.depth);
    }
  }

  return depths;
}
