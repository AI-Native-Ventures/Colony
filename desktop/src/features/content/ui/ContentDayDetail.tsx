import * as React from "react";

import { invokeTauri } from "@/shared/api/tauri";
import { copyTextToSystemClipboard } from "@/shared/api/tauriMedia";
import { KIND_CONTENT_POST } from "@/shared/constants/kinds";
import { rewriteRelayUrl } from "@/shared/lib/mediaUrl";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

import type { ContentDecision, ContentPost, CorrectionBin } from "../contracts";
import { evaluateClaimGate } from "../claimVerifier";
import { buildDecisionEvent } from "../contentDecisions";
import {
  decisionsForPost,
  postChip,
  unverifiedSummary,
} from "../contentStatus";
import { useClaimVerification, useContentClaimStrictness } from "../hooks";
import { packFilename, postPackText } from "../postPack";
import { ContentChecksPanel } from "./ContentChecksPanel";
import { ContentClaimsList } from "./ContentClaimsList";
import { ContentRenderPanel } from "./ContentRenderPanel";

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
  communityId: string;
  post: ContentPost;
  decisions: ContentDecision[];
  /** The current house style version, for the made-before-changes notice. */
  styleVersion: string | null;
  submitting: boolean;
  onSubmit: (input: {
    post: ContentPost;
    decision: "approve" | "change";
    note?: string | null;
    correction?: { bin: CorrectionBin; text: string } | null;
  }) => Promise<unknown>;
};

export function ContentDayDetail({
  communityId,
  decisions,
  onSubmit,
  post,
  styleVersion,
  submitting,
}: Props) {
  const [note, setNote] = React.useState("");
  const [bin, setBin] = React.useState<CorrectionBin>("card");
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const verification = useClaimVerification(communityId, post);
  const strictnessQuery = useContentClaimStrictness(communityId);
  const verdicts = verification.data ?? {};
  const gate = React.useMemo(
    () =>
      evaluateClaimGate(
        post.claims,
        verdicts,
        strictnessQuery.data ?? "strict",
      ),
    [post.claims, strictnessQuery.data, verdicts],
  );

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

  // Copies the whole pack, not just the caption: hashtags and alt text are
  // both going into the posting box too, and copying them one at a time is
  // three round trips through this panel for one post.
  const handleCopyPack = React.useCallback(async () => {
    const text = postPackText(post);
    if (text.length === 0) {
      return;
    }
    await copyTextToSystemClipboard(text);
    setCopied(true);
  }, [post]);

  const handleDownload = React.useCallback(async () => {
    setError(null);
    try {
      for (const [index, image] of post.images.entries()) {
        // Sequential: each opens a save dialog, and two dialogs at once is a
        // fight over the same window.
        await invokeTauri("download_image", {
          filename: packFilename(post, index, post.images.length),
          url: image.url,
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [post]);

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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      {/* The card on a mat. The image is the thing being approved, so it gets
          the top of the panel, a quiet ground behind it, and no chrome. */}
      <div className="bg-muted/30 px-5 py-5">
        {post.images.length > 0 ? (
          // Every slide, not the first: a carousel's running order is the
          // thing a grid of independent cards cannot show, and showing one of
          // four hides three quarters of what is being approved.
          <div className="flex flex-col gap-4">
            {post.images.map((image, index) => (
              <figure key={image.sha256}>
                <img
                  alt={post.alt ?? post.headline ?? "Rendered card"}
                  className="w-full rounded-lg object-contain shadow-md"
                  src={rewriteRelayUrl(image.url)}
                />
                {post.images.length > 1 ? (
                  <figcaption className="mt-1.5 text-center text-2xs text-muted-foreground">
                    Slide {index + 1} of {post.images.length}
                  </figcaption>
                ) : null}
              </figure>
            ))}
          </div>
        ) : (
          <div className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-1 rounded-lg bg-background/60 text-center">
            <p className="text-sm text-muted-foreground">
              Nothing rendered yet.
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-6 px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* The headline is the panel header's title; repeating it here
                cost a line of vertical space and said the same thing twice. */}
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

        {post.images.length > 0 &&
        styleVersion !== null &&
        post.styleVersion !== null &&
        post.styleVersion !== styleVersion ? (
          // Plain words on purpose: the owner never sees version numbers. The
          // render panel right below is the "remake it" affordance.
          <p className="rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            This card was made before your latest changes. Draw it again to
            bring it up to date.
          </p>
        ) : null}

        <ContentRenderPanel communityId={communityId} post={post} />

        {unverified ? (
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {unverified}
          </p>
        ) : null}

        <ContentChecksPanel reports={post.gateReports} />
        <ContentClaimsList claims={post.claims} verdicts={verdicts} />

        {strictnessQuery.data === "advisory" && gate.warnings.length > 0 ? (
          <div className="rounded-lg bg-amber-500/10 px-3 py-2">
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
              Advisory mode: this card renders, but these claims are not backed.
            </p>
            <ul className="mt-1 list-inside list-disc">
              {gate.warnings.map((warning) => (
                <li
                  className="text-xs text-amber-700 dark:text-amber-300"
                  key={warning}
                >
                  {warning}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {post.images.length > 0 ? (
          // The handover. An approved card that cannot leave the app was
          // never published, however well it measured, and until now the only
          // way out was selecting the caption by hand.
          <section>
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Take it away
              </h4>
              <div className="flex gap-2">
                <Button onClick={handleDownload} size="sm" variant="outline">
                  {post.images.length > 1
                    ? `Save ${post.images.length} slides`
                    : "Save the card"}
                </Button>
                <Button onClick={handleCopyPack} size="sm" variant="outline">
                  {copied ? "Copied" : "Copy the words"}
                </Button>
              </div>
            </div>
            <p className="mt-1.5 text-2xs text-muted-foreground">
              Caption, hashtags and alt text, in posting order.
            </p>
          </section>
        ) : null}

        {post.caption ? (
          <section>
            <div className="flex items-baseline justify-between gap-3">
              <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                Caption
              </h4>
              <Button onClick={handleCopyPack} size="sm" variant="ghost">
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed">
              {post.caption}
            </p>
            {post.hashtags.length > 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                For repurposing:{" "}
                {post.hashtags.map((tag) => `#${tag}`).join(" ")}
              </p>
            ) : null}
          </section>
        ) : null}

        {post.alt ? (
          <section>
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              Alt text
            </h4>
            <p className="mt-1.5 text-sm text-muted-foreground">{post.alt}</p>
          </section>
        ) : null}

        {/* The decision. Approve is the biggest thing in the panel below the
            card itself, because reacting is the whole job here. */}
        <section className="rounded-xl bg-muted/30 p-4">
          <p className="text-sm font-medium">Your call</p>
          {approvalRefusal ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {approvalRefusal}
            </p>
          ) : null}

          <Button
            className="mt-3 w-full"
            disabled={submitting || approvalRefusal !== null}
            onClick={handleApprove}
          >
            Approve
          </Button>

          <div className="mt-4">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="content-change-note"
            >
              Ask for a change
            </label>
            <textarea
              className="mt-1.5 w-full rounded-lg border border-input/40 bg-background p-2.5 text-sm"
              id="content-change-note"
              onChange={(event) => setNote(event.target.value)}
              placeholder="What is wrong with it?"
              rows={2}
              value={note}
            />

            {note.trim().length > 0 ? (
              <div className="mt-2">
                <p className="text-xs font-medium text-muted-foreground">
                  How long should this apply?
                </p>
                <div className="mt-1.5 flex flex-wrap gap-2">
                  {BIN_ORDER.map((option) => (
                    <Button
                      className="rounded-full"
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
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    This becomes a house rule. You can read and delete it later
                    in Style.
                  </p>
                ) : null}
              </div>
            ) : null}

            <Button
              className="mt-2 w-full"
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
        </section>

        {own.length > 0 ? (
          <section>
            <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              History
            </h4>
            <ul className="mt-2 space-y-2">
              {own.map((decision) => (
                <li
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                  key={decision.eventId}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "mt-1.5 h-1 w-1 shrink-0 rounded-full",
                      decision.decision === "approve"
                        ? "bg-emerald-500"
                        : "bg-amber-500",
                    )}
                  />
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">
                      {decision.decision === "approve"
                        ? "Approved"
                        : "Sent back"}
                    </span>
                    {decision.note ? `: ${decision.note}` : ""}
                    {decision.correction
                      ? ` (${BIN_LABELS[decision.correction.bin].toLowerCase()})`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
