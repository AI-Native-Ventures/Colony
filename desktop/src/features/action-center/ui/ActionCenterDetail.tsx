import { ClipboardList } from "lucide-react";

import type { ActionBlockItem, ActionItem } from "../contracts";
import { ActionCenterAskDetail } from "./ActionCenterAskDetail";
import { ActionCenterBlockDetail } from "./ActionCenterBlockDetail";
import { ActionCenterPingDetail } from "./ActionCenterPingDetail";
import { ActionCenterReminderDetail } from "./ActionCenterReminderDetail";
import { ActionCenterResolvedAskDetail } from "./ActionCenterResolvedAskDetail";
import { ActionCenterWorkflowDetail } from "./ActionCenterWorkflowDetail";
import { Button } from "@/shared/ui/button";

export function ActionCenterDetail({
  currentPubkey,
  item,
  onBack,
  onDismissPing,
  onOpenSource,
  onRefresh,
  onThreadReplySent,
  resolvingAskIds,
  unavailableItemId,
}: {
  currentPubkey: string;
  item: ActionItem | null;
  onBack: () => void;
  onDismissPing: (pingId: string) => Promise<void>;
  onOpenSource: (item: ActionItem) => void;
  onRefresh: () => Promise<void>;
  onThreadReplySent: (threadId: string) => void;
  resolvingAskIds: ReadonlySet<string>;
  unavailableItemId: string | null;
}) {
  if (!item) {
    if (unavailableItemId) {
      return (
        <section
          className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background/60 px-6 py-10 text-center"
          data-testid="action-center-detail-unavailable"
        >
          <div className="max-w-sm">
            <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <ClipboardList className="size-6" />
            </div>
            <p className="mt-4 text-base font-semibold">
              This action is no longer available
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              The source may have been completed, withdrawn, or removed. Refresh
              to check again.
            </p>
            <p className="mt-3 break-all font-mono text-2xs text-muted-foreground">
              {unavailableItemId}
            </p>
            <Button
              className="mt-4"
              onClick={() => void onRefresh()}
              size="sm"
              variant="outline"
            >
              Refresh sources
            </Button>
          </div>
        </section>
      );
    }
    return (
      <section
        className="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-background/60 px-6 py-10 text-center"
        data-testid="action-center-detail-empty"
      >
        <div className="max-w-sm">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <ClipboardList className="size-6" />
          </div>
          <p className="mt-4 text-base font-semibold">Select an action</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose an item to answer it, open its source, or update its state.
          </p>
        </div>
      </section>
    );
  }

  switch (item.source.kind) {
    case "ask":
      // A closed ask shows how it closed instead of an answer form.
      if (item.source.resolution) {
        return (
          <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background/60">
            <ActionCenterResolvedAskDetail
              onOpenSource={
                item.capabilities.includes("open-source")
                  ? () => onOpenSource(item)
                  : undefined
              }
              source={item.source}
            />
          </section>
        );
      }
      return (
        <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background/60">
          <ActionCenterAskDetail
            ask={item.source.ask}
            isResolving={resolvingAskIds.has(item.source.ask.id)}
            onOpenSource={
              item.capabilities.includes("open-source")
                ? () => onOpenSource(item)
                : undefined
            }
            onThreadReplySent={onThreadReplySent}
          />
        </section>
      );
    case "block":
      return (
        <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background/60">
          <ActionCenterBlockDetail
            item={item as ActionBlockItem}
            onOpenSource={
              item.capabilities.includes("open-source")
                ? () => onOpenSource(item)
                : undefined
            }
          />
        </section>
      );
    case "reminder":
      return (
        <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background/60">
          <ActionCenterReminderDetail
            onBack={onBack}
            pubkey={currentPubkey}
            reminder={item.source.reminder}
          />
        </section>
      );
    case "workflow":
      return (
        <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background/60">
          <ActionCenterWorkflowDetail
            onOpenSource={() => onOpenSource(item)}
            source={item.source}
          />
        </section>
      );
    case "ping": {
      // Bound to a const so the closures below capture an already-narrowed
      // value: narrowing `item.source.kind` does not survive into a closure
      // over the wider `item.source` property-access chain, since TS cannot
      // prove `item` stays what it was between the switch check and whenever
      // the closure actually runs.
      const source = item.source;
      return (
        <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background/60">
          <ActionCenterPingDetail
            onDismiss={() => onDismissPing(source.ping.id)}
            onOpenSource={
              item.capabilities.includes("open-source")
                ? () => onOpenSource(item)
                : undefined
            }
            source={source}
            title={item.title}
          />
        </section>
      );
    }
  }
}
