import * as React from "react";

import { VirtualizedList } from "@/shared/ui/VirtualizedList";

import type { ActionItem, ActionItemState } from "../contracts";
import { ActionCenterRow } from "./ActionCenterRow";

const GROUP_LABEL: Record<ActionItemState, string> = {
  failed: "Needs attention",
  "needs-action": "Needs action",
  active: "In progress",
  completed: "Recently completed",
};

type ListEntry =
  | { kind: "header"; key: string; label: string }
  | { kind: "item"; key: string; item: ActionItem };

function listEntries(items: readonly ActionItem[]): ListEntry[] {
  const entries: ListEntry[] = [];
  let previousState: ActionItemState | null = null;
  for (const item of items) {
    if (item.state !== previousState) {
      entries.push({
        kind: "header",
        key: `group:${item.state}`,
        label: GROUP_LABEL[item.state],
      });
      previousState = item.state;
    }
    entries.push({ kind: "item", key: item.id, item });
  }
  return entries;
}

export function ActionCenterList({
  items,
  onSelect,
  resolvingAskIds,
  selectedId,
}: {
  items: ActionItem[];
  onSelect: (itemId: string) => void;
  resolvingAskIds: ReadonlySet<string>;
  selectedId: string | null;
}) {
  const entries = React.useMemo(() => listEntries(items), [items]);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  if (items.length === 0) {
    return (
      <div
        className="flex min-h-64 flex-1 items-center justify-center px-6 text-center"
        data-testid="action-center-empty"
      >
        <div>
          <p className="text-sm font-medium text-foreground">
            Nothing needs your attention
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            New asks, reminders, and actionable work will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="action-center-list"
      ref={scrollRef}
    >
      <VirtualizedList
        estimateSize={88}
        getItemKey={(entry) => entry.key}
        items={entries}
        renderItem={(entry) =>
          entry.kind === "header" ? (
            <div className="border-b border-border/35 px-4 pb-1 pt-4 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
              {entry.label}
            </div>
          ) : (
            <ActionCenterRow
              isResolving={
                entry.item.source.kind === "ask" &&
                resolvingAskIds.has(entry.item.source.ask.id)
              }
              isSelected={entry.item.id === selectedId}
              item={entry.item}
              onSelect={() => onSelect(entry.item.id)}
            />
          )
        }
        scrollRef={scrollRef}
      />
    </div>
  );
}
