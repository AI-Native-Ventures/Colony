import {
  AtSign,
  Bell,
  Blocks,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  Workflow,
} from "lucide-react";

import type { ActionItem, ActionItemKind, ActionItemState } from "../contracts";
import { cn } from "@/shared/lib/cn";
import { Badge, type BadgeProps } from "@/shared/ui/badge";

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

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1_000) - timestamp);
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
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
  return (
    <button
      aria-current={isSelected ? "true" : undefined}
      aria-label={`${item.title}: ${item.summary}`}
      className={cn(
        "group flex w-full items-start gap-3 border-b border-border/45 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
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
        <span className="flex min-w-0 items-start gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {item.title}
          </span>
          <span className="shrink-0 text-2xs text-muted-foreground">
            {formatAge(item.updatedAt)}
          </span>
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
