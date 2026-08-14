import { Check, ExternalLink, RotateCcw } from "lucide-react";

import type { ActionMessageItem } from "../contracts";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";

export function ActionCenterMessageDetail({
  item,
  onMarkDone,
  onOpenSource,
  onUndoDone,
}: {
  item: ActionMessageItem;
  onMarkDone: () => void;
  onOpenSource?: () => void;
  onUndoDone: () => void;
}) {
  const { source } = item;
  const isDone = source.isDone;
  return (
    <section
      className="flex min-h-full flex-col"
      data-testid="action-center-message-detail"
    >
      <div className="border-b border-border/60 px-5 py-5">
        <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {source.item.category === "agent_activity"
            ? "Agent update"
            : "Message"}
          {source.item.channelName ? ` · #${source.item.channelName}` : ""}
        </div>
        <h2 className="mt-2 text-lg font-semibold text-foreground">
          {item.title}
        </h2>
        <div className="mt-2 text-xs text-muted-foreground">
          {new Date(source.item.createdAt * 1_000).toLocaleString()}
        </div>
      </div>
      <div className="flex-1 px-5 py-5">
        <Markdown
          className="text-base"
          content={source.item.content || item.summary}
          interactive={false}
        />
        <div className="mt-6 flex flex-wrap gap-2">
          {onOpenSource ? (
            <Button onClick={onOpenSource} size="sm" variant="outline">
              <ExternalLink className="mr-2 size-4" />
              Open source thread
            </Button>
          ) : (
            <p className="text-sm text-muted-foreground">
              This message has no channel link.
            </p>
          )}
          {isDone ? (
            <Button onClick={onUndoDone} size="sm" variant="ghost">
              <RotateCcw className="mr-2 size-4" />
              Put back in Action Center
            </Button>
          ) : (
            <Button onClick={onMarkDone} size="sm" variant="secondary">
              <Check className="mr-2 size-4" />
              Mark done
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
