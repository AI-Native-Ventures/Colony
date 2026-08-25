import { ClipboardList } from "lucide-react";

import type { ActionItem, ActionMessageItem } from "../contracts";
import { ActionCenterAskDetail } from "./ActionCenterAskDetail";
import { ActionCenterMessageDetail } from "./ActionCenterMessageDetail";
import { ActionCenterReminderDetail } from "./ActionCenterReminderDetail";
import { ActionCenterResolvedAskDetail } from "./ActionCenterResolvedAskDetail";
import { ActionCenterTaskDetail } from "./ActionCenterTaskDetail";
import { ActionCenterWorkflowDetail } from "./ActionCenterWorkflowDetail";
import { Button } from "@/shared/ui/button";

export function ActionCenterDetail({
  currentPubkey,
  item,
  onBack,
  onMarkDone,
  onOpenSource,
  onRefresh,
  onUndoDone,
  unavailableItemId,
}: {
  currentPubkey: string;
  item: ActionItem | null;
  onBack: () => void;
  onMarkDone: (item: ActionItem) => void;
  onOpenSource: (item: ActionItem) => void;
  onRefresh: () => Promise<void>;
  onUndoDone: (item: ActionItem) => void;
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
            onOpenSource={
              item.capabilities.includes("open-source")
                ? () => onOpenSource(item)
                : undefined
            }
          />
        </section>
      );
    case "message":
      return (
        <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background/60">
          <ActionCenterMessageDetail
            item={item as ActionMessageItem}
            onMarkDone={() => onMarkDone(item)}
            onOpenSource={
              item.capabilities.includes("open-source")
                ? () => onOpenSource(item)
                : undefined
            }
            onUndoDone={() => onUndoDone(item)}
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
    case "task":
      return (
        <section className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background/60">
          <ActionCenterTaskDetail
            onOpenSource={
              item.capabilities.includes("open-source")
                ? () => onOpenSource(item)
                : undefined
            }
            source={item.source}
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
  }
}
