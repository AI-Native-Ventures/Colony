import * as React from "react";

import {
  buildDelegationContent,
  delegationClientTags,
} from "@/features/factory/lib/delegation";
import { nativeErrorMessage } from "@/features/factory/lib/nativeErrorMessage";
import { sendChannelMessage } from "@/shared/api/sendChannelMessage";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Textarea } from "@/shared/ui/textarea";

export type DelegateTarget = { pubkey: string; name: string };

export type DelegationSent = {
  /** Thread the delegation now lives in — the delegate's tile opens onto it. */
  threadRootId: string;
  eventId: string;
};

/**
 * Hand a piece of this agent's work to another agent, in this agent's thread.
 *
 * The message is posted by the signed-in owner rather than by the delegating
 * agent — a person is clicking Send — so the delegation marker names both
 * sides explicitly. Everything else is an ordinary threaded mention, which is
 * what makes the delegate's harness see it at all.
 */
export function DelegateAgentDialog({
  channelId,
  delegator,
  onOpenChange,
  onSent,
  open,
  target,
}: {
  channelId: string;
  delegator: { pubkey: string; name: string; threadRootId: string | null };
  onOpenChange: (open: boolean) => void;
  onSent: (sent: DelegationSent) => void;
  open: boolean;
  target: DelegateTarget | null;
}): React.JSX.Element {
  const [body, setBody] = React.useState("");
  const [replyExpected, setReplyExpected] = React.useState(true);
  const [sending, setSending] = React.useState(false);
  const [problem, setProblem] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setBody("");
    setReplyExpected(true);
    setProblem(null);
  }, [open]);

  async function handleSend() {
    if (!target) return;
    const trimmed = body.trim();
    if (!trimmed) {
      setProblem("Say what you are handing over.");
      return;
    }
    setSending(true);
    setProblem(null);
    try {
      // A delegation is always a reply, so both tiles can derive their cards
      // from the same thread-replies query. An agent that has not spoken yet
      // has no thread, so one is opened for it first.
      let threadRootId = delegator.threadRootId;
      if (!threadRootId) {
        const root = await sendChannelMessage({
          channelId,
          content: `${delegator.name} is delegating.`,
          mentionPubkeys: [delegator.pubkey],
        });
        threadRootId = root.rootEventId ?? root.eventId;
      }
      const posted = await sendChannelMessage({
        channelId,
        content: buildDelegationContent(trimmed, replyExpected),
        parentEventId: threadRootId,
        mentionPubkeys: [target.pubkey],
        clientTags: delegationClientTags({
          from: delegator.pubkey,
          to: target.pubkey,
          replyExpected,
        }),
      });
      onSent({ threadRootId, eventId: posted.eventId });
      onOpenChange(false);
    } catch (caught) {
      setProblem(nativeErrorMessage(caught, "Could not delegate."));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" data-testid="delegate-agent-dialog">
        <DialogHeader>
          <DialogTitle>Delegate to {target?.name ?? "an agent"}</DialogTitle>
          <DialogDescription>
            It lands in {delegator.name}'s thread as a mention, so both agents
            read the same conversation.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          className="min-h-28"
          data-testid="delegate-agent-body"
          disabled={sending}
          onChange={(event) => setBody(event.target.value)}
          placeholder={`What should ${target?.name ?? "they"} pick up?`}
          value={body}
        />

        <div className="flex items-center gap-2">
          <Checkbox
            checked={replyExpected}
            data-testid="delegate-agent-reply-expected"
            disabled={sending}
            id="delegate-agent-reply-expected"
            onCheckedChange={(checked) => setReplyExpected(checked === true)}
          />
          <label
            className="text-sm text-foreground"
            htmlFor="delegate-agent-reply-expected"
          >
            Reply expected
          </label>
        </div>

        {problem ? (
          <p
            className="text-sm text-destructive"
            data-testid="delegate-agent-error"
            role="alert"
          >
            {problem}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            data-testid="delegate-agent-send"
            disabled={sending || !target}
            onClick={() => void handleSend()}
            type="button"
          >
            {sending ? "Sending..." : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
