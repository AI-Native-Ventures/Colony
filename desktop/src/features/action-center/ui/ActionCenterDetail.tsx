import { ClipboardList } from "lucide-react";

import type { ActionItem, ActionMessageItem } from "../contracts";
import { ActionCenterAskDetail } from "./ActionCenterAskDetail";
import { ActionCenterMessageDetail } from "./ActionCenterMessageDetail";
import { ActionCenterReminderDetail } from "./ActionCenterReminderDetail";
import { ActionCenterTaskDetail } from "./ActionCenterTaskDetail";
import { ActionCenterWorkflowDetail } from "./ActionCenterWorkflowDetail";

export function ActionCenterDetail({
  currentPubkey,
  item,
  onBack,
  onMarkDone,
  onOpenSource,
  onUndoDone,
}: {
  currentPubkey: string;
  item: ActionItem | null;
  onBack: () => void;
  onMarkDone: (item: ActionItem) => void;
  onOpenSource: (item: ActionItem) => void;
  onUndoDone: (item: ActionItem) => void;
}) {
  if (!item) {
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
