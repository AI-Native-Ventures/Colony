import { ChevronDown, ChevronRight, Pencil, Save, X } from "lucide-react";
import * as React from "react";

import {
  useSetThreadCanvasMutation,
  useThreadCanvasQuery,
} from "@/features/messages/hooks";
import { useChannelNavigation } from "@/shared/context/ChannelNavigationContext";
import { Button } from "@/shared/ui/button";
import { Markdown } from "@/shared/ui/markdown";
import { Textarea } from "@/shared/ui/textarea";
import {
  isRelayUnreachableError,
  RELAY_UNREACHABLE_SHORT,
} from "@/shared/lib/relayError";
import { cn } from "@/shared/lib/cn";

type ThreadCanvasPanelProps = {
  channelId: string | null;
  threadRootId: string;
  canEdit: boolean;
};

/**
 * Collapsible memory panel at the top of the thread view.
 *
 * Holds this thread's working memory (kind 40100 scoped to the level-1 root
 * by an `e` tag). Expanded by default when the canvas has content so a reader
 * lands on the summary first; collapsed when empty so an unused thread does
 * not spend vertical space on an empty promise.
 */
export function ThreadCanvasPanel({
  channelId,
  threadRootId,
  canEdit,
}: ThreadCanvasPanelProps) {
  const canvasQuery = useThreadCanvasQuery(channelId, threadRootId);
  const setCanvasMutation = useSetThreadCanvasMutation(channelId, threadRootId);
  const { channels } = useChannelNavigation();
  const channelNames = React.useMemo(
    () => channels.filter((c) => c.channelType !== "dm").map((c) => c.name),
    [channels],
  );
  const [userExpanded, setUserExpanded] = React.useState<boolean | null>(null);
  const [isEditing, setIsEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");

  const canvasContent = canvasQuery.data?.content ?? null;
  // Defer the single large Markdown parse so opening the panel commits the
  // surrounding chrome immediately and the heavy render reconciles after.
  const deferredCanvasContent = React.useDeferredValue(canvasContent);
  const expanded =
    userExpanded ?? (canvasQuery.isSuccess ? canvasContent !== null : false);

  if (canvasQuery.isPending) {
    return null;
  }

  if (canvasQuery.error instanceof Error) {
    return (
      <p className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {isRelayUnreachableError(canvasQuery.error)
          ? RELAY_UNREACHABLE_SHORT
          : canvasQuery.error.message}
      </p>
    );
  }

  function handleStartEditing() {
    setDraft(canvasContent ?? "");
    setIsEditing(true);
    setUserExpanded(true);
  }

  function handleCancelEditing() {
    setIsEditing(false);
    setDraft("");
  }

  async function handleSave() {
    await setCanvasMutation.mutateAsync(draft);
    setIsEditing(false);
  }

  const editor = (
    <div className="space-y-3">
      <Textarea
        aria-label="Thread canvas content"
        className="min-h-40 font-mono text-sm"
        data-testid="thread-canvas-editor"
        disabled={setCanvasMutation.isPending}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Write what a colleague joining this thread now would need..."
        value={draft}
      />
      <div className="flex gap-2">
        <Button
          data-testid="thread-canvas-save"
          disabled={setCanvasMutation.isPending}
          onClick={() => {
            void handleSave().catch(() => {
              // Error is surfaced below via setCanvasMutation.error
            });
          }}
          size="sm"
          type="button"
        >
          <Save className="h-4 w-4" />
          {setCanvasMutation.isPending ? "Saving..." : "Save canvas"}
        </Button>
        <Button
          data-testid="thread-canvas-cancel"
          disabled={setCanvasMutation.isPending}
          onClick={handleCancelEditing}
          size="sm"
          type="button"
          variant="outline"
        >
          <X className="h-4 w-4" />
          Cancel
        </Button>
      </div>
      {setCanvasMutation.error instanceof Error ? (
        <p
          className="text-sm text-destructive"
          data-testid="thread-canvas-save-error"
        >
          {setCanvasMutation.error.message}
        </p>
      ) : null}
    </div>
  );

  return (
    <div
      className="overflow-hidden rounded-2xl border border-border/70 bg-muted/20"
      data-testid="thread-canvas-panel"
    >
      <button
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
        data-testid="thread-canvas-toggle"
        onClick={() => setUserExpanded(!expanded)}
        type="button"
      >
        {expanded ? (
          <ChevronDown
            aria-hidden
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
        ) : (
          <ChevronRight
            aria-hidden
            className="h-4 w-4 shrink-0 text-muted-foreground"
          />
        )}
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Thread canvas
        </span>
        {canvasContent ? (
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs text-muted-foreground",
              expanded && "hidden",
            )}
            data-testid="thread-canvas-preview"
          >
            {firstLine(canvasContent)}
          </span>
        ) : (
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground/70"
            data-testid="thread-canvas-empty-hint"
          >
            Nothing recorded yet
          </span>
        )}
      </button>

      {expanded ? (
        <div className="px-3 pb-3">
          {isEditing ? (
            editor
          ) : canvasContent ? (
            <>
              <div className="pt-1" data-testid="thread-canvas-content">
                <Markdown
                  channelNames={channelNames}
                  content={deferredCanvasContent ?? ""}
                />
              </div>
              {canEdit ? (
                <div className="mt-2 flex justify-end">
                  <Button
                    data-testid="thread-canvas-edit"
                    onClick={handleStartEditing}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Pencil className="h-4 w-4" />
                    Edit canvas
                  </Button>
                </div>
              ) : null}
            </>
          ) : (
            <div className="pt-1">
              <p
                className="text-sm text-muted-foreground"
                data-testid="thread-canvas-empty"
              >
                Nothing recorded yet. Agents working this thread record their
                findings here.
              </p>
              {canEdit ? (
                <Button
                  className="mt-2"
                  data-testid="thread-canvas-edit"
                  onClick={handleStartEditing}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Pencil className="h-4 w-4" />
                  Create canvas
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function firstLine(content: string): string {
  const line = content.trimStart().split("\n", 1)[0] ?? "";
  const withoutMarkers = line.replace(/^#+\s*/, "");
  return withoutMarkers.length > 0 ? withoutMarkers : line;
}
