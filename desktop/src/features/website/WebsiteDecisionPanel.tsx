import * as React from "react";
import { CircleAlert, Loader2 } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";

import {
  beginDecisionDispatch,
  clearDecisionFailure,
  completeDecisionDispatch,
  confirmDecisionReceipt,
  createDecisionPanelState,
  decisionScopeKey,
  failDecisionDispatch,
  isDispatchCurrent,
  setDecisionNote,
  withDecisionScope,
  type WebsiteDecisionPanelState,
} from "./decisionPanelState";
import {
  buildDecisionRequest,
  countNoteCharacters,
  decisionIdentityKey,
  evaluateDecisionEligibility,
  resolvePendingDecision,
  revalidateDecisionRequest,
  WEBSITE_NOTE_MAX_CHARS,
} from "./reviewLogic";
import type {
  WebsiteDecisionKind,
  WebsiteDecisionReceipt,
  WebsiteDecisionRequest,
  WebsiteReviewRecord,
} from "./types";

export type WebsiteDecisionPanelProps = {
  record: WebsiteReviewRecord;
  /** Explicit version the controls target; the payload is pinned to it. */
  selectedRevision: number;
  /** Viewing identity; authority is evaluated against the record. */
  actor: string;
  /**
   * Injected dispatch. Resolves with the relay receipt; the panel then stays
   * pending until the canonical record contains the decision. Rejects on a
   * real dispatch failure and shows the message with a retry.
   */
  onDecision?: (
    request: WebsiteDecisionRequest,
  ) => Promise<WebsiteDecisionReceipt | void>;
  className?: string;
};

/**
 * Owner-facing approve / request-changes controls pinned to one exact version
 * and manifest. Pending and stale selections disable both actions; a dispatch
 * is never treated as success until the canonical record proves it. Local
 * state is scoped to community job/task/actor, so a late result from a
 * previous card can never land on a newer one. Retries re-validate the exact
 * stored payload against the current record and stay disabled when stale.
 */
export function WebsiteDecisionPanel({
  record,
  selectedRevision,
  actor,
  onDecision,
  className,
}: WebsiteDecisionPanelProps) {
  const noteId = React.useId();
  const scopeKey = decisionScopeKey({
    channel: record.channel,
    jobId: record.jobId,
    taskId: record.taskId,
    actor,
  });
  const [rawState, setRawState] = React.useState<WebsiteDecisionPanelState>(
    () => createDecisionPanelState(scopeKey),
  );
  const scopeRef = React.useRef(scopeKey);
  scopeRef.current = scopeKey;

  // Prop-scope change (job switch, viewer switch): reset synchronously, before
  // any effect or async callback can observe stale local state.
  const state = withDecisionScope(rawState, scopeKey);
  if (state !== rawState) setRawState(state);

  React.useEffect(() => {
    if (state.scopeKey !== scopeKey || !state.pending) return;
    const pending = state.pending;
    const resolution = resolvePendingDecision({ record, pending });
    if (resolution.status === "recorded") {
      setRawState((previous) =>
        previous.scopeKey === scopeKey
          ? completeDecisionDispatch(previous)
          : previous,
      );
      return;
    }
    if (resolution.status === "conflict" || resolution.status === "invalid") {
      setRawState((previous) =>
        previous.scopeKey === scopeKey
          ? failDecisionDispatch(previous, {
              message: resolution.message,
              request: pending.request,
              conflict: resolution.status === "conflict",
            })
          : previous,
      );
    }
  }, [record, scopeKey, state.pending, state.scopeKey]);

  const dispatch = React.useCallback(
    (request: WebsiteDecisionRequest) => {
      if (!onDecision) return;
      const dispatchScope = scopeKey;
      setRawState((previous) =>
        beginDecisionDispatch(withDecisionScope(previous, dispatchScope), {
          request,
          identityKey: decisionIdentityKey(request),
        }),
      );
      Promise.resolve(onDecision(request))
        .then((result) => {
          if (!isDispatchCurrent(dispatchScope, scopeRef.current)) return;
          setRawState((previous) =>
            result
              ? confirmDecisionReceipt(
                  withDecisionScope(previous, dispatchScope),
                  result,
                )
              : withDecisionScope(previous, dispatchScope),
          );
        })
        .catch((cause: unknown) => {
          if (!isDispatchCurrent(dispatchScope, scopeRef.current)) return;
          setRawState((previous) =>
            failDecisionDispatch(withDecisionScope(previous, dispatchScope), {
              message:
                cause instanceof Error
                  ? cause.message
                  : "The decision could not be sent.",
              request,
              conflict: false,
            }),
          );
        });
    },
    [onDecision, scopeKey],
  );

  const failedRequest = state.failed?.request ?? null;
  const retryCheck = failedRequest
    ? revalidateDecisionRequest({ record, request: failedRequest, actor })
    : null;
  const retryAllowed = Boolean(retryCheck?.ok);
  const busy = Boolean(state.pending) || Boolean(state.failed);
  const eligibility = evaluateDecisionEligibility({
    record,
    selectedRevision,
    actor,
    pending: busy,
  });
  const revision = record.revisions.find(
    (entry) => entry.revision === selectedRevision,
  );
  const isCurrent = selectedRevision === record.currentRevision;
  const noteLength = countNoteCharacters(state.note);

  const submit = (kind: WebsiteDecisionKind) => {
    if (!eligibility.matched) return;
    const built = buildDecisionRequest({
      record,
      kind,
      revision: eligibility.matched.revision,
      manifestSha256: eligibility.matched.manifestSha256,
      actor,
      note: state.note,
    });
    if (!built.ok) {
      setRawState((previous) =>
        failDecisionDispatch(withDecisionScope(previous, scopeKey), {
          message: built.message,
          conflict: false,
        }),
      );
      return;
    }
    dispatch(built.request);
  };

  const reasons = eligibility.reasons.slice(0, 3);
  const failureText =
    failedRequest && retryCheck && !retryCheck.ok
      ? retryCheck.message
      : (state.failed?.message ?? "");

  return (
    <section
      aria-label="Your decision"
      className={cn("border-t border-border px-3.5 py-3", className)}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-xs font-medium text-foreground">
          Your review of Version {selectedRevision}
        </h4>
        <span className="text-2xs text-muted-foreground">
          {isCurrent ? "Current version" : "Earlier version"}
        </span>
      </div>

      {state.pending ? (
        <p
          aria-live="polite"
          className="mt-2 flex items-start gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-2xs text-muted-foreground"
        >
          <Loader2
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 animate-spin"
          />
          <span>
            {state.receipt
              ? "Confirming your decision."
              : "Saving your decision."}
          </span>
        </p>
      ) : null}
      {state.pending && state.receipt ? (
        <details className="mt-1 text-2xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            Details
          </summary>
          <span className="mt-1 block break-all font-mono text-3xs">
            Event {state.receipt.eventId}
          </span>
        </details>
      ) : null}

      {state.failed ? (
        <div
          className={cn(
            "mt-2 flex flex-col gap-1.5 rounded-md border px-2.5 py-2 text-2xs",
            state.failed.conflict
              ? "border-amber-500/40 bg-amber-500/10"
              : "border-destructive/40 bg-destructive/10",
          )}
          role="alert"
        >
          <span className="flex items-start gap-1.5 text-foreground">
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span>{failureText}</span>
          </span>
          <span className="flex items-center gap-2">
            {failedRequest ? (
              <Button
                disabled={!retryAllowed}
                onClick={() => {
                  if (retryAllowed) dispatch(failedRequest);
                }}
                size="xs"
                type="button"
                variant="outline"
              >
                Try again
              </Button>
            ) : null}
            <button
              className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() =>
                setRawState((previous) =>
                  previous.scopeKey === scopeKey
                    ? clearDecisionFailure(previous)
                    : previous,
                )
              }
              type="button"
            >
              Dismiss
            </button>
          </span>
        </div>
      ) : null}

      <label
        className="mt-2 flex flex-col gap-1 text-2xs text-muted-foreground"
        htmlFor={noteId}
      >
        <span>
          Feedback for the team
          {revision ? ` on Version ${revision.revision}` : ""}
        </span>
        <Textarea
          className="min-h-16 text-sm"
          disabled={busy}
          id={noteId}
          onChange={(event) =>
            setRawState((previous) =>
              previous.scopeKey === scopeKey
                ? setDecisionNote(previous, event.target.value)
                : previous,
            )
          }
          placeholder="Describe what should change, or leave a note with an approval."
          rows={3}
          value={state.note}
        />
      </label>
      <div className="mt-1 flex justify-end">
        <span
          className={cn(
            "text-3xs",
            noteLength > WEBSITE_NOTE_MAX_CHARS
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {noteLength} / {WEBSITE_NOTE_MAX_CHARS}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          disabled={!eligibility.canApprove || !onDecision}
          onClick={() => submit("approve")}
          size="sm"
          type="button"
        >
          Approve design
        </Button>
        <Button
          disabled={!eligibility.canRequestChanges || !onDecision}
          onClick={() => submit("requestChanges")}
          size="sm"
          type="button"
          variant="outline"
        >
          Request changes
        </Button>
      </div>

      {!onDecision ? (
        <p className="mt-2 text-2xs text-muted-foreground">
          Recording a decision is not available in this build.
        </p>
      ) : null}

      {reasons.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {reasons.map((reason) => (
            <li className="text-2xs text-muted-foreground" key={reason.code}>
              {reason.message}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2 text-2xs text-muted-foreground">
        Design approval prepares the handover. It does not publish the site.
      </p>
    </section>
  );
}
