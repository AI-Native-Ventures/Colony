import { ClipboardList, Loader2 } from "lucide-react";

import { BlockCard } from "@/features/blocks/ui/primitives/BlockCard";
import { FIRST_JOB_BRIEF_MAX_LENGTH } from "@/features/onboarding/firstJobStart";
import {
  FirstJobFundingView,
  type FirstJobFundingViewProps,
} from "@/features/onboarding/ui/FirstJobFundingView";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";

/** Setup interaction states are separate from authoritative task execution. */
export type FirstJobSuggestionPhase =
  | "suggested"
  | "checking"
  | "needs-credits"
  | "blocked"
  | "sending"
  | "uncertain"
  | "sent"
  | "error";

/** The parent supplies the canonical task's label; the view never invents one. */
export type FirstJobTaskState = {
  label: string;
  tone: "neutral" | "active" | "warning" | "success" | "danger";
};

/** Controlled state shared by both rendered copies of the same thread root. */
export type FirstJobSuggestionViewProps = {
  idPrefix: string;
  businessName: string;
  businessSummary?: string;
  scoutName?: string;
  brief: string;
  briefLocked?: boolean;
  phase: FirstJobSuggestionPhase;
  canManage: boolean;
  error?: string | null;
  taskState?: FirstJobTaskState | null;
  funding?: Omit<FirstJobFundingViewProps, "idPrefix"> | null;
  onBriefChange: (brief: string) => void;
  onStart: () => void;
  onRetry: () => void;
  onAddCredits: () => void;
  onExplore: () => void;
  onReviewTeam?: () => void;
};

const CARD = { type: "card" } as const;

function phaseMessage(phase: FirstJobSuggestionPhase) {
  switch (phase) {
    case "checking":
      return "Checking your credits and team…";
    case "needs-credits":
      return "Add credits before starting this job. Your brief stays here.";
    case "blocked":
      return "An approved worker is not available for this job yet. Review your team, then try again.";
    case "sending":
      return "Sending your request to the team…";
    case "uncertain":
      return "We could not confirm that the request arrived. Check its status to safely resume the same request.";
    case "sent":
      return "Task sent";
    case "error":
      return "This job could not start. Your brief stays here; try again.";
    default:
      return null;
  }
}

/** A setup-authored suggestion inside the existing conversation, never an agent reply. */
export function FirstJobSuggestionView({
  idPrefix,
  businessName,
  businessSummary,
  scoutName = "Scout",
  brief,
  briefLocked = false,
  phase,
  canManage,
  error,
  taskState,
  funding,
  onBriefChange,
  onStart,
  onRetry,
  onAddCredits,
  onExplore,
  onReviewTeam,
}: FirstJobSuggestionViewProps) {
  const busy = phase === "checking" || phase === "sending";
  const locked =
    briefLocked || busy || phase === "uncertain" || phase === "sent";
  const validBrief =
    !!brief.trim() && brief.trim().length <= FIRST_JOB_BRIEF_MAX_LENGTH;
  const titleId = `${idPrefix}-suggestion-title`;
  const briefId = `${idPrefix}-brief`;
  const hintId = `${idPrefix}-brief-hint`;
  const showFunding = canManage && !!funding && phase !== "sent";
  const fundingActive = showFunding && funding.phase !== "funded";
  const status = taskState?.label ?? phaseMessage(phase);

  return (
    <section
      aria-busy={busy}
      aria-labelledby={titleId}
      className="my-3 min-w-0 max-w-2xl text-sm leading-6"
      data-phase={phase}
      data-testid="first-job-suggestion"
    >
      <BlockCard
        className="gap-0 bg-card p-4 hover:bg-card"
        data={null}
        node={CARD}
      >
        <div className="flex items-start gap-3">
          <div
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
          >
            <ClipboardList className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">
              Setup suggestion
            </p>
            <h3
              className="break-words text-sm font-semibold leading-6 text-foreground"
              id={titleId}
            >
              A first job for {businessName}
            </h3>
            <p className="text-sm text-muted-foreground">
              {scoutName} coordinates this job
            </p>
          </div>
        </div>

        {businessSummary ? (
          <p className="break-words text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
            {businessSummary}
          </p>
        ) : null}

        <div className="space-y-1.5">
          {canManage ? (
            <label
              className="text-sm font-medium text-foreground"
              htmlFor={briefId}
            >
              The brief
            </label>
          ) : (
            <p className="text-sm font-medium text-foreground">The brief</p>
          )}
          {canManage ? (
            <Textarea
              aria-describedby={hintId}
              className="min-h-28 resize-y leading-6"
              id={briefId}
              maxLength={FIRST_JOB_BRIEF_MAX_LENGTH}
              onChange={(event) => onBriefChange(event.target.value)}
              readOnly={locked}
              rows={4}
              value={brief}
            />
          ) : (
            <p
              className="whitespace-pre-wrap break-words rounded-lg border border-border/70 bg-background px-3 py-2 text-sm leading-6 [overflow-wrap:anywhere]"
              id={briefId}
            >
              {brief}
            </p>
          )}
          <p className="text-xs leading-5 text-muted-foreground" id={hintId}>
            {locked
              ? "This brief stays the same while we check or resume your request."
              : canManage
                ? "Edit this before starting. Your team will work in this thread."
                : "A suggestion from Colony setup. The owner can choose when to start."}
          </p>
        </div>

        {error ? (
          <p className="text-sm leading-6 text-destructive" role="alert">
            {error}
          </p>
        ) : null}
        {status && (!error || taskState) && (!showFunding || taskState) ? (
          <p
            className={cn(
              "flex items-start gap-2 text-sm leading-6 text-muted-foreground",
              taskState?.tone === "danger" && "text-destructive",
              taskState?.tone === "active" && "text-primary",
              taskState?.tone === "success" && "font-medium text-foreground",
            )}
            data-testid="first-job-status"
            role="status"
          >
            {busy ? (
              <Loader2
                aria-hidden="true"
                className="mt-1 size-4 shrink-0 animate-spin motion-reduce:animate-none"
              />
            ) : null}
            {status}
          </p>
        ) : null}

        {showFunding ? (
          <FirstJobFundingView {...funding} idPrefix={idPrefix} />
        ) : null}

        {canManage && !fundingActive && phase !== "sent" ? (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {phase === "needs-credits" && funding?.phase !== "funded" ? (
              <Button onClick={onAddCredits} type="button">
                Add credits
              </Button>
            ) : phase === "blocked" ||
              phase === "error" ||
              phase === "uncertain" ? (
              <Button disabled={!validBrief} onClick={onRetry} type="button">
                {phase === "uncertain" ? "Check request" : "Try again"}
              </Button>
            ) : (
              <Button
                disabled={busy || !validBrief}
                onClick={onStart}
                type="button"
              >
                {busy
                  ? phase === "checking"
                    ? "Checking…"
                    : "Sending…"
                  : "Start this job"}
              </Button>
            )}
            {phase === "blocked" && onReviewTeam ? (
              <Button onClick={onReviewTeam} type="button" variant="outline">
                Review team
              </Button>
            ) : null}
            <Button
              disabled={busy}
              onClick={onExplore}
              type="button"
              variant="ghost"
            >
              Explore for now
            </Button>
          </div>
        ) : null}
      </BlockCard>
    </section>
  );
}
