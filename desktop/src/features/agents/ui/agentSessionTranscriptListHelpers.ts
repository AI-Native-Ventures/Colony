import type { ActiveTurnSummary } from "@/features/agents/activeAgentTurnsStore";
import type { ActivityRowStats } from "./activityRenderClasses/ActivityRow";
import type { FileEditDiff } from "./agentSessionFileEditDiff";
import type { AgentSessionTranscriptVariant } from "./agentSessionTranscriptContext";
import {
  formatTurnSetupLabel,
  turnSetupDetail,
  type TranscriptDisplayBlock,
  type TranscriptTurnSegment,
} from "./agentSessionTranscriptGrouping";
import { buildCompactToolSummary } from "./agentSessionToolSummary";
import type { TranscriptItem } from "./agentSessionTypes";
import { hasFileEditLineDiff } from "./FileEditDiffView";

/**
 * Pure helpers for `AgentSessionTranscriptList`. Extracted so the list
 * component holds layout and the sibling holds derivation.
 */

export function isAgentTurnLive(
  activeTurns: ActiveTurnSummary[],
  channelId: string | null,
) {
  if (activeTurns.length === 0) {
    return false;
  }
  if (!channelId) {
    return true;
  }
  return activeTurns.some((turn) => turn.channelId === channelId);
}

export function hasRenderableDisplayContent(
  displayBlocks: TranscriptDisplayBlock[],
  variant: AgentSessionTranscriptVariant,
) {
  if (variant !== "compactPreview") {
    return displayBlocks.length > 0;
  }

  return displayBlocks.some(hasRenderableCompactBlock);
}

function hasRenderableCompactBlock(block: TranscriptDisplayBlock) {
  if (block.kind === "single") {
    return isRenderableCompactItem(block.item);
  }

  // session-boundary dividers are not renderable content in compact view.
  if (block.kind === "session-boundary") {
    return false;
  }

  return block.segments.some((segment) => {
    if (segment.kind === "item") {
      return isRenderableCompactItem(segment.item);
    }
    if (segment.kind === "prompt") {
      return true;
    }
    if (segment.kind === "summary") {
      return segment.summary.items.some(isRenderableCompactItem);
    }
    return false;
  });
}

function isRenderableCompactItem(item: TranscriptItem) {
  return item.renderClass !== "raw-rail" && item.renderClass !== "suppressed";
}

export function getTurnSegmentKey(
  turnId: string,
  segment: TranscriptTurnSegment,
) {
  if (segment.kind === "setup") {
    return `turn:${turnId}:setup`;
  }
  if (segment.kind === "prompt") {
    // A turn can hold multiple prompt segments (initial prompt + mid-turn
    // steers), so key on the user message id rather than the bare turn id.
    return `turn:${turnId}:prompt:${segment.user.id}`;
  }
  if (segment.kind === "summary") {
    return segment.summary.id;
  }
  return segment.item.id;
}

export function getGroupedFileEditDiffs(
  items: TranscriptItem[],
): FileEditDiff[] {
  return items.flatMap((item) => {
    if (item.type !== "tool" || item.isError) {
      return [];
    }

    const diff = buildCompactToolSummary(item).fileEditDiff;
    return diff && hasFileEditLineDiff(diff) ? [diff] : [];
  });
}

export function summarizeFileEditDiffs(
  diffs: FileEditDiff[],
): ActivityRowStats | null {
  if (diffs.length === 0) {
    return null;
  }

  return diffs.reduce(
    (stats, diff) => ({
      additions: stats.additions + diff.additions,
      deletions: stats.deletions + diff.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

export function formatPromptSetupSummary(
  items: Extract<TranscriptItem, { type: "lifecycle" }>[],
) {
  const label = formatTurnSetupLabel(items);
  const detail = turnSetupDetail(items);
  return [label, detail].filter(Boolean).join(" · ");
}

export function getTranscriptMessageLink(
  item: Extract<TranscriptItem, { type: "message" }>,
) {
  if (!item.channelId || !item.messageId) return null;
  return {
    channelId: item.channelId,
    messageId: item.messageId,
  };
}
