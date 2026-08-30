import {
  AtSign,
  Bell,
  Blocks,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  Workflow,
} from "lucide-react";

import { actionItemAccent } from "../actionCenterModel";
import type { ActionItem, ActionItemKind, ActionItemState } from "../contracts";
import { formatDurationCoarse } from "../lib/durationFormat";
import { cn } from "@/shared/lib/cn";
import { Badge, type BadgeProps } from "@/shared/ui/badge";
import { AskCountdown } from "./AskCountdown";

const KIND_ICON: Record<ActionItemKind, typeof CircleHelp> = {
  ask: CircleHelp,
  reminder: Bell,
  workflow: Workflow,
  block: Blocks,
  ping: AtSign,
};

const STATE_LABEL: Record<ActionItemState, string> = {
  "needs-action": "Needs action",
  active: "In progress",
  failed: "Failed",
  completed: "Done",
};

const STATE_VARIANT: Record<ActionItemState, BadgeProps["variant"]> = {
  "needs-action": "warning",
  active: "info",
  failed: "destructive",
  completed: "secondary",
};

/** Left border for the two tiers the wireframe accents (spec "Layout":
 * `.item.countdown` / `.item.blocked`). Everything else stays plain. */
const ACCENT_BORDER_CLASS: Record<
  NonNullable<ReturnType<typeof actionItemAccent>>,
  string
> = {
  countdown: "border-l-2 border-l-destructive",
  blocked: "border-l-2 border-l-warning",
};

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1_000) - timestamp);
  const coarse = formatDurationCoarse(seconds);
  return coarse === "just now" ? coarse : `${coarse} ago`;
}

/**
 * The row's meta slot (top-right of the title row): a live countdown for a
 * tier-1 ask, "waiting <age> - never auto-resolves" for a tier-2 hard-list
 * ask (spec: a persistent marker, since it can never default-execute), or
 * plain age for everything else.
 */
function RowMeta({ item }: { item: ActionItem }) {
  if (item.source.kind === "ask" && item.state === "needs-action") {
    const { ask, deadlineAt, isHardList } = item.source;
    if (ask.defaultOption !== null) {
      return (
        <AskCountdown
          defaultOption={ask.defaultOption}
          deadlineAt={deadlineAt}
        />
      );
    }
    if (isHardList) {
      return (
        <span
          className="text-2xs font-medium text-warning"
          data-testid="action-center-hard-list-marker"
        >
          waiting{" "}
          {formatDurationCoarse(
            Math.floor(Date.now() / 1_000) - item.createdAt,
          )}{" "}
          - never auto-resolves
        </span>
      );
    }
  }
  return (
    <span className="text-2xs text-muted-foreground">
      {formatAge(item.updatedAt)}
    </span>
  );
}

export function sourceLabel(item: ActionItem): string {
  switch (item.source.kind) {
    case "ask":
      // A closed ask's meta line names HOW it closed. An executed default
      // (the relay answered because the deadline passed with nobody
      // answering) must be tellable from a human answer at a glance.
      if (item.source.resolution?.defaultExecuted) return "Default executed";
      if (item.source.resolution) return "Answered";
      return item.source.ask.channelId ? "Ask from a thread" : "Global ask";
    case "reminder":
      return item.source.reminder.content.target
        ? "Message reminder"
        : "Personal reminder";
    case "workflow":
      return item.source.approval ? "Approval required" : "Workflow run";
    case "block":
      // The row's state badge already says whether the decision is resolved.
      // The meta line only has to say what KIND of thing this is without
      // protocol vocabulary.
      return item.source.awaitingDecision ? "Block waiting on you" : "Block";
    case "ping":
      return "Waiting on you in a thread";
  }
}

export function ActionCenterRow({
  isResolving = false,
  isSelected,
  item,
  onSelect,
}: {
  /** True while a threaded reply just answered this ask and it is waiting
   * for the relay's auto-resolve to confirm on the next open-asks refetch. */
  isResolving?: boolean;
  isSelected: boolean;
  item: ActionItem;
  onSelect: () => void;
}) {
  const Icon = KIND_ICON[item.kind];
  const accent = actionItemAccent(item);
  // Gated on state too, not just isHardList: a settled (answered) ask keeps
  // isHardList true on its source forever, but "never auto-resolves" is
  // only a live warning while the ask is still open.
  const isHardListAsk =
    item.state === "needs-action" &&
    item.source.kind === "ask" &&
    item.source.isHardList;
  return (
    <button
      aria-current={isSelected ? "true" : undefined}
      aria-label={`${item.title}: ${item.summary}`}
      className={cn(
        "group flex w-full items-start gap-3 border-b border-border/45 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
        accent && ACCENT_BORDER_CLASS[accent],
        isSelected && "bg-muted/45",
        isResolving && "opacity-60",
      )}
      data-testid={`action-center-item-${item.id}`}
      onClick={onSelect}
      type="button"
    >
      <span
        className={cn(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
          item.state === "failed" && "bg-destructive/10 text-destructive",
          item.state === "needs-action" && "bg-primary/10 text-primary",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        {/* Title and meta each get their own full-width line rather than
            sharing one: proven by screenshot that sharing does not work at
            this row's real width (384px, list-pane). The title uses flex-1
            (flex-basis: 0%), so a meta sibling whose own content already
            overflows the row leaves flex-grow nothing to distribute and the
            title renders at effectively zero width -- capping the meta's
            max-width only made both unreadably short, not fixed the
            problem. A countdown or an escalation-heavy title needs real
            room, and this row already has several lines below it, so one
            more line is cheap. */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {item.title}
          </span>
          {isHardListAsk &&
          item.source.kind === "ask" &&
          item.source.ask.category ? (
            <Badge
              className="shrink-0"
              data-testid="action-center-hard-list-badge"
              variant="destructive"
            >
              {item.source.ask.category.toUpperCase()}
            </Badge>
          ) : null}
        </span>
        <span className="mt-0.5 block truncate">
          <RowMeta item={item} />
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-2xs font-medium uppercase tracking-wide",
            item.source.kind === "ask" &&
              item.source.resolution?.defaultExecuted === true
              ? "text-warning"
              : "text-muted-foreground",
          )}
        >
          {isResolving ? "Reply sent · resolving…" : sourceLabel(item)}
        </span>
        <span className="mt-1 block truncate text-sm text-muted-foreground">
          {item.summary}
        </span>
        {item.contextLine ? (
          <span
            className="mt-1 block truncate text-2xs text-muted-foreground/80"
            data-testid="action-center-context-line"
          >
            {item.contextLine}
          </span>
        ) : null}
        {item.escalationLine ? (
          <span
            className="mt-1 block truncate text-2xs text-muted-foreground/80"
            data-testid="action-center-escalation-line"
          >
            {item.escalationLine}
          </span>
        ) : null}
      </span>
      <Badge className="mt-0.5 shrink-0" variant={STATE_VARIANT[item.state]}>
        {STATE_LABEL[item.state]}
      </Badge>
      {item.capabilities.includes("open-source") ? (
        <ExternalLink
          aria-hidden
          className="mt-1 hidden size-3.5 shrink-0 text-muted-foreground group-hover:block group-focus-visible:block"
        />
      ) : null}
      {item.state === "failed" ? (
        <CircleAlert
          aria-hidden
          className="mt-1 size-3.5 shrink-0 text-destructive"
        />
      ) : null}
    </button>
  );
}

export function actionStateLabel(state: ActionItemState): string {
  return STATE_LABEL[state];
}
