import * as React from "react";
import { ArrowUp, MessagesSquare } from "lucide-react";

import { useChannelPanelHistoryState } from "@/features/channels/ui/useChannelPanelHistoryState";
import { nativeErrorMessage } from "@/features/factory/lib/nativeErrorMessage";
import { setChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";
import { sendChannelMessage } from "@/shared/api/sendChannelMessage";
import { cn } from "@/shared/lib/cn";
import { Textarea } from "@/shared/ui/textarea";

/**
 * The tile's composer.
 *
 * Every send mentions the agent so the harness's own author gate sees it. The
 * first send has no parent: the event it creates becomes the tile's thread
 * root, which the caller persists into the tab payload so later sends reply
 * into that same thread.
 */
export function AgentTileComposer({
  agentName,
  agentPubkey,
  channelId,
  onThreadRooted,
  threadRootId,
}: {
  agentName: string;
  agentPubkey: string;
  channelId: string;
  /** Called with the root event id after a send that created the thread. */
  onThreadRooted: (rootEventId: string) => void;
  threadRootId: string | null;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const { setOpenThreadHeadId } = useChannelPanelHistoryState();

  const send = React.useCallback(async () => {
    const content = draft.trim();
    if (!content || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await sendChannelMessage({
        channelId,
        content,
        parentEventId: threadRootId,
        mentionPubkeys: [agentPubkey],
      });
      setDraft("");
      if (!threadRootId) {
        onThreadRooted(result.rootEventId ?? result.eventId);
      }
    } catch (caught) {
      setError(nativeErrorMessage(caught, "Could not send the message."));
    } finally {
      setSending(false);
    }
  }, [agentPubkey, channelId, draft, onThreadRooted, sending, threadRootId]);

  const openThread = React.useCallback(() => {
    if (!threadRootId) return;
    setChannelSurfaceMode(channelId, "timeline");
    setOpenThreadHeadId(threadRootId);
  }, [channelId, setOpenThreadHeadId, threadRootId]);

  return (
    <div
      className="shrink-0 border-t border-border/60 px-3 py-2"
      data-testid="agent-tile-composer"
    >
      <Textarea
        className="min-h-16 resize-none border-border/40 text-sm"
        data-testid="agent-tile-composer-input"
        disabled={sending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          void send();
        }}
        placeholder={`Message ${agentName}...`}
        value={draft}
      />
      <div className="mt-1.5 flex items-center gap-2">
        {threadRootId ? (
          <button
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="agent-tile-open-thread"
            onClick={openThread}
            type="button"
          >
            <MessagesSquare aria-hidden className="h-3.5 w-3.5" />
            Open thread
          </button>
        ) : null}
        {error ? (
          <span
            className="min-w-0 truncate text-xs text-destructive"
            data-testid="agent-tile-composer-error"
          >
            {error}
          </span>
        ) : null}
        <span className="flex-1" />
        <button
          aria-label={`Send to ${agentName}`}
          className={cn(
            "inline-flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground",
            "disabled:opacity-40",
          )}
          data-testid="agent-tile-composer-send"
          disabled={sending || draft.trim().length === 0}
          onClick={() => void send()}
          type="button"
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
