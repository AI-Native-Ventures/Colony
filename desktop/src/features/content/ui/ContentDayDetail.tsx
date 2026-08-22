import * as React from "react";

import { copyTextToSystemClipboard } from "@/shared/api/tauriMedia";
import { KIND_CONTENT_POST } from "@/shared/constants/kinds";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

import type { ContentDecision, ContentPost, CorrectionBin } from "../contracts";
import { buildDecisionEvent } from "../contentDecisions";
import {
  decisionsForPost,
  postChip,
  unverifiedSummary,
} from "../contentStatus";
import { ContentChecksPanel } from "./ContentChecksPanel";
import { ContentClaimsList } from "./ContentClaimsList";

/**
 * One day, everything about it, and the two things the owner can do.
 *
 * The correction loop is the important half. Everything good about the cards
 * this feature was built from came from an owner typing articulate art
 * direction nine times, and the customer will not do that: rejection is cheap
 * and articulation is expensive. So the change form asks for one sentence, and
 * then asks the one question that decides whether it is worth anything later,
 * which is how long it should live.
 *
 * The bin is deliberately not chosen for them and not left to them alone. An
 * agent choosing silently produces the drift failure, where a one-off gets
 * promoted to a rule and followed for months. Asking them to invent the
 * category is homework, and homework does not get done. So the form proposes
 * "just this card" and they change it in one click.
 *
 * The caller keys this component on the post address, so moving to another day
 * remounts it and clears the form. A note typed for Tuesday cannot be
 * submitted against Wednesday.
 */

const BIN_LABELS: Record<CorrectionBin, string> = {
  card: "Just this card",
  rule: "Every card, from now on",
  setting: "Until I change it",
};

const BIN_ORDER: CorrectionBin[] = ["card", "setting", "rule"];

type Props = {
  post: ContentPost;
  decisions: ContentDecision[];
  submitting: boolean;
  onSubmit: (input: {
    post: ContentPost;
    decision: "approve" | "change";
    note?: string | null;
    correction?: { bin: CorrectionBin; text: string } | null;
  }) => Promise<unknown>;
};

export function ContentDayDetail({
  decisions,
  onSubmit,
  post,
  submitting,
}: Props) {
  const [note, setNote] = React.useState("");
  const [bin, setBin] = React.useState<CorrectionBin>("card");
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const own = React.useMemo(
    () => decisionsForPost(post, decisions, KIND_CONTENT_POST),
    [decisions, post],
  );
  const chip = React.useMemo(() => postChip(post, own), [own, post]);
  const unverified = React.useMemo(() => unverifiedSummary(post), [post]);

  const approvalRefusal = React.useMemo(() => {
    const draft = buildDecisionEvent({ decision: "approve", post });
    return draft.ok ? null : draft.reason;
  }, [post]);

  const handleCopyCaption = React.useCallback(async () => {
    if (!post.caption) {
      return;
    }
    await copyTextToSystemClipboard(post.caption);
    setCopied(true);
  }, [post.caption]);

  const handleApprove = React.useCallback(async () => {
    setError(null);
    try {
      await onSubmit({ decision: "approve", post });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [onSubmit, post]);

  const handleRequestChange = React.useCallback(async () => {
    setError(null);
    const trimmed = note.trim();
    try {
      await onSubmit({
        correction: trimmed.length > 0 ? { bin, text: trimmed } : null,
        decision: "change",
        note: trimmed,
        post,
      });
      setNote("");
      setBin("card");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [bin, note, onSubmit, post]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">
            {post.headline ?? post.slug}
          </h2>
          <p className="text-xs text-muted-foreground">
            Week {post.week} · {post.scheduledFor}
            {post.job ? ` · ${post.job}` : ""}
            {post.channel ? ` · ${post.channel}` : ""}
          </p>
        </div>
        <Badge
          title={chip.detail}
          variant={
            chip.tone === "good"
              ? "success"
              : chip.tone === "bad"
                ? "destructive"
                : chip.tone === "warn"
                  ? "warning"
                  : "outline"
          }
        >
          {chip.label}
        </Badge>
      </div>

      {post.images.length > 0 ? (
        <img
          alt={post.alt ?? post.headline ?? "Rendered card"}
          className="w-full rounded-lg border border-border/60 object-contain"
          src={rewriteRelayUrl(post.images[0].url)}
        />
      ) : (
        <div className="rounded-lg border border-dashed border-border/60 p-6 text-center text-sm text-muted-foreground">
          Nothing rendered yet.
        </div>
      )}

      {unverified ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          {unverified}
        </p>
      ) : null}

      <ContentChecksPanel reports={post.gateReports} />
      <ContentClaimsList claims={post.claims} />

      {post.caption ? (
        <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium">Caption</p>
            <Button onClick={handleCopyCaption} size="sm" variant="ghost">
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm">{post.caption}</p>
          {post.hashtags.length > 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              For repurposing: {post.hashtags.map((tag) => `#${tag}`).join(" ")}
            </p>
          ) : null}
        </div>
      ) : null}

      {post.alt ? (
        <div className="rounded-lg border border-border/60 bg-muted/10 p-3">
          <p className="text-sm font-medium">Alt text</p>
          <p className="mt-1 text-sm text-muted-foreground">{post.alt}</p>
        </div>
      ) : null}

      <div className="rounded-lg border border-border/60 p-3">
        <p className="text-sm font-medium">Your call</p>
        {approvalRefusal ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {approvalRefusal}
          </p>
        ) : null}

        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            disabled={submitting || approvalRefusal !== null}
            onClick={handleApprove}
            size="sm"
          >
            Approve
          </Button>
        </div>

        <div className="mt-4">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor="content-change-note"
          >
            Ask for a change
          </label>
          <textarea
            className="mt-1 w-full rounded-md border border-input/40 bg-background p-2 text-sm"
            id="content-change-note"
            onChange={(event) => setNote(event.target.value)}
            placeholder="What is wrong with it?"
            rows={3}
            value={note}
          />

          {note.trim().length > 0 ? (
            <div className="mt-2">
              <p className="text-xs font-medium text-muted-foreground">
                How long should this apply?
              </p>
              <div className="mt-1 flex flex-wrap gap-2">
                {BIN_ORDER.map((option) => (
                  <Button
                    key={option}
                    onClick={() => setBin(option)}
                    size="sm"
                    variant={bin === option ? "secondary" : "outline"}
                  >
                    {BIN_LABELS[option]}
                  </Button>
                ))}
              </div>
              {bin === "rule" ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  This becomes a house rule. You can read and delete it later in
                  Style.
                </p>
              ) : null}
            </div>
          ) : null}

          <Button
            className="mt-2"
            disabled={submitting || note.trim().length === 0}
            onClick={handleRequestChange}
            size="sm"
            variant="outline"
          >
            Send it back
          </Button>
        </div>

        {error ? (
          <p className="mt-2 text-xs text-destructive">{error}</p>
        ) : null}
      </div>

      {own.length > 0 ? (
        <div className="rounded-lg border border-border/60 p-3">
          <p className="text-sm font-medium">History</p>
          <ul className="mt-2 space-y-2">
            {own.map((decision) => (
              <li
                className="text-xs text-muted-foreground"
                key={decision.eventId}
              >
                <span className="font-medium text-foreground">
                  {decision.decision === "approve" ? "Approved" : "Sent back"}
                </span>
                {decision.note ? `: ${decision.note}` : ""}
                {decision.correction
                  ? ` (${BIN_LABELS[decision.correction.bin].toLowerCase()})`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
