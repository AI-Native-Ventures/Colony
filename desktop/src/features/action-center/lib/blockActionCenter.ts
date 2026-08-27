import { parseBlockInstance } from "@/features/blocks/blockTags";
import type {
  BlockInstanceRef,
  BlockManifestRecord,
} from "@/features/blocks/contracts";
import { blockPermissionLabels } from "@/features/blocks/ui/BlockDisclosure";
import type { FeedItem } from "@/shared/api/types";

import type { ActionBlockSource, ActionCapability } from "../contracts";

const MAX_TITLE_LENGTH = 140;
const MAX_SUMMARY_LENGTH = 200;

/**
 * Strips the little markdown a Block fallback template uses for its opening
 * line (`## Title`, `**Title**`) so a queue row shows the sentence rather than
 * its punctuation. Everything else in the line is left alone.
 */
function stripLeadingMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\*\*(.*?)\*\*$/, "$1")
    .replace(/^\*(.*?)\*$/, "$1")
    .replace(/^_(.*?)_$/, "$1")
    .trim();
}

function truncate(value: string, limit: number): string {
  return value.length > limit
    ? `${value.slice(0, limit - 1).trimEnd()}…`
    : value;
}

/**
 * The headline and supporting line a Block's plain-text fallback already
 * carries. Every core Block's `fallback_template` opens with a human sentence,
 * so the queue row can read like the Block instead of like a tag dump.
 */
export function blockFallbackLines(content: string): {
  headline: string;
  detail: string;
} {
  const lines = content
    .split("\n")
    .map((line) => stripLeadingMarkdown(line))
    .filter((line) => line !== "");
  const headline = lines[0] ?? "";
  const detail = lines.slice(1).join(" · ");
  return {
    headline: truncate(headline, MAX_TITLE_LENGTH),
    detail: truncate(detail, MAX_SUMMARY_LENGTH),
  };
}

export type BlockFeedProjection = {
  source: ActionBlockSource;
  title: string;
  summary: string;
  capabilities: ActionCapability[];
};

/**
 * A Block that is still waiting on this person is never offered "Mark done".
 * Only the Block's own declared resolving action produces the receipt the relay
 * subtracts, and that receipt can only be signed by the instance's pinned
 * processor. Local dismissal cannot stand in for it, so the capability is a
 * different one and the UI says what it really does.
 *
 * Once nothing waits on this person (the decision was resolved elsewhere, or
 * the view never required attention), the row is pure information and local
 * dismissal is honest tidying, so "Mark done" is offered again. A row that is
 * already dismissed locally offers "undo-done" instead.
 */
export function blockCapabilities({
  awaitingDecision,
  hasChannel,
  isDone,
}: {
  awaitingDecision: boolean;
  hasChannel: boolean;
  isDone: boolean;
  /**
   * Whether the instance declares attention at all. Accepted so callers state
   * the full situation, but deliberately not consulted: a declared-attention
   * row the relay no longer counts as open is treated exactly like any other
   * resolved row. Distinguishing it would leave such rows stuck in the queue
   * with no dismissal at all.
   */
  requiresAttention: boolean;
}): ActionCapability[] {
  return [
    "decide-inline",
    ...(hasChannel ? (["open-source"] as const) : []),
    ...(isDone
      ? (["undo-done"] as const)
      : awaitingDecision
        ? (["hide-locally"] as const)
        : (["mark-done"] as const)),
  ];
}

/**
 * The status the surfaces state out loud for a Block row: what it still wants
 * from this person, or that it only left their list. `null` when there is
 * nothing worth saying (the decision was resolved elsewhere, or the view never
 * asked anything of them).
 *
 * The row summary and the detail pane header both derive from here so they can
 * never disagree about what a row means.
 */
export function blockStatusLine(source: {
  awaitingDecision: boolean;
  isDone: boolean;
  instance: Pick<BlockInstanceRef, "attentionRequired">;
  item: Pick<FeedItem, "category">;
}): string | null {
  if (source.awaitingDecision) return "Waiting for your decision.";
  // A locally hidden row is not a resolved one. It left this person's list
  // only; the relay still counts the instance as open, and no surface may
  // claim otherwise.
  if (
    source.isDone &&
    source.instance.attentionRequired &&
    source.item.category === "needs_action"
  ) {
    return "Hidden from your list, but this still needs your decision.";
  }
  return null;
}

/**
 * Projects a feed item that carries Block instance tags.
 *
 * Returns `null` for anything that is not a well-formed Block instance, so an
 * ordinary message (or a malformed Block) falls through to the message
 * projection and keeps its existing behaviour.
 *
 * `awaitingDecision` is taken from the relay's own verdict, not recomputed: the
 * needs-action feed is already Block-aware and subtracts resolved receipts, so
 * an item that arrives in any other category has either been resolved or never
 * needed this person.
 */
export function projectBlockFeedItem(
  item: FeedItem,
  threadRootId: string | null,
  isDone: boolean,
): BlockFeedProjection | null {
  const parsed = parseBlockInstance(item.tags);
  if (!parsed.ok) return null;
  const instance: BlockInstanceRef = parsed.value;
  const relayStillWaiting =
    instance.attentionRequired && item.category === "needs_action";
  const awaitingDecision = relayStillWaiting && !isDone;
  const { headline, detail } = blockFallbackLines(item.content);
  const source: ActionBlockSource = {
    kind: "block",
    item,
    instance,
    threadRootId,
    isDone,
    awaitingDecision,
  };
  const fallbackSummary =
    blockStatusLine(source) ??
    (instance.attentionRequired
      ? "This decision is already resolved."
      : "An inline view was shared with you.");
  return {
    source,
    title: headline || "Inline view",
    summary: detail || fallbackSummary,
    capabilities: blockCapabilities({
      awaitingDecision,
      hasChannel: item.channelId !== null,
      isDone,
      requiresAttention: instance.attentionRequired,
    }),
  };
}

export type BlockDismissal =
  | {
      kind: "hide-locally";
      label: string;
      /**
       * Visible, never sr-only: hiding an unresolved row is the one dismissal
       * whose effect differs from what "done" would suggest, so the person
       * pressing the button is told what actually happens.
       */
      explanation: string;
    }
  | { kind: "mark-done"; label: string; explanation: null }
  | { kind: "undo-done"; label: string; explanation: null };

/**
 * The one dismissal the detail pane offers, derived from the same capability
 * matrix the row was projected with so the two can never disagree.
 *
 * Relay reality this copy leans on without restating it: only the pinned
 * processor's receipt resolves the instance, and only the named decision
 * maker's signature gets that receipt. A local hide therefore cannot close
 * anything, and the explanation says so in product words.
 */
export function blockDismissal(
  capabilities: readonly ActionCapability[],
): BlockDismissal | null {
  if (capabilities.includes("undo-done")) {
    return {
      kind: "undo-done",
      label: "Put back in Action Center",
      explanation: null,
    };
  }
  if (capabilities.includes("hide-locally")) {
    return {
      kind: "hide-locally",
      label: "Hide from my list",
      explanation:
        "Hiding only removes the row here. It does not answer this view, so the work waiting on it stays blocked.",
    };
  }
  if (capabilities.includes("mark-done")) {
    return { kind: "mark-done", label: "Mark done", explanation: null };
  }
  return null;
}

export type BlockDetailDisclosure = {
  untrusted: boolean;
  permissionLabels: string[];
};

/**
 * The two trust facts the detail pane must say out loud next to the decision
 * buttons: that the publisher is untrusted, and any capability the view asks
 * for. `null` while the manifest is unknown, so a loading or failed manifest
 * shows no verdict it cannot stand behind.
 */
export function blockDetailDisclosure(
  manifestRecord: BlockManifestRecord | null,
): BlockDetailDisclosure | null {
  if (!manifestRecord) return null;
  return {
    untrusted: manifestRecord.trust === "untrusted",
    permissionLabels: blockPermissionLabels(
      manifestRecord.manifest.permissions,
    ),
  };
}
