import * as React from "react";
import { Check, Loader2 } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import {
  awaitBriefConfirmation,
  beginBriefStart,
  briefScopeKey,
  createBriefStartState,
  failBriefStart,
} from "./briefState";
import { isScopeCurrent } from "./scopedAsync";
import { useScopedState } from "./useScopedState";
import { WebsiteSourceRow } from "./SourceRow";
import type {
  WebsiteBriefView,
  WebsiteReviewRecord,
  WebsiteStartRequest,
} from "./types";

export type WebsiteBriefProps = {
  record: WebsiteReviewRecord;
  /** Agent-authored brief content from the canonical job event. */
  brief?: WebsiteBriefView;
  /**
   * Injected start action. It receives the exact job/task/channel scope so a
   * retry is idempotent. Until the canonical record moves out of `draft` the
   * UI shows a waiting state, never a fabricated success.
   */
  onStart?: (request: WebsiteStartRequest) => Promise<void> | void;
  className?: string;
};

function BriefLines({
  heading,
  lines,
}: {
  heading: string;
  lines: readonly string[];
}) {
  const unique = Array.from(new Set(lines));
  if (unique.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs font-medium text-muted-foreground">
        {heading}
      </span>
      <ul className="flex flex-col gap-1">
        {unique.map((line) => (
          <li
            className="flex items-start gap-1.5 text-xs text-foreground"
            key={line}
          >
            <Check
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0 text-emerald-600"
            />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The brief state: the owner-supplied source, the confirmed scope from the
 * canonical brief event, and a start action with an explicit waiting or
 * failure state. Local start state is scoped to the exact job/task/channel,
 * and a successful dispatch is not shown as success until the record leaves
 * `draft`.
 */
export function WebsiteBrief({
  record,
  brief,
  onStart,
  className,
}: WebsiteBriefProps) {
  const startRequest: WebsiteStartRequest = {
    jobId: record.jobId,
    taskId: record.taskId,
    channel: record.channel,
  };
  const scopeKey = briefScopeKey(startRequest);
  const scopeRef = React.useRef(scopeKey);
  scopeRef.current = scopeKey;
  const [startState, setStartState] = useScopedState(
    scopeKey,
    createBriefStartState,
  );

  const start = () => {
    if (!onStart) return;
    const dispatchScope = scopeKey;
    setStartState(beginBriefStart());
    Promise.resolve(onStart(startRequest))
      .then(() => {
        if (!isScopeCurrent(dispatchScope, scopeRef.current)) return;
        setStartState(awaitBriefConfirmation());
      })
      .catch((cause: unknown) => {
        if (!isScopeCurrent(dispatchScope, scopeRef.current)) return;
        setStartState(
          failBriefStart(
            cause instanceof Error
              ? cause.message
              : "The redesign could not be started.",
          ),
        );
      });
  };

  return (
    <section
      aria-label="Website redesign brief"
      className={cn("border-t border-border px-3.5 py-3", className)}
    >
      <WebsiteSourceRow className="mb-3" record={record} />

      {brief ? (
        <div className="flex flex-col gap-3">
          {brief.summary ? (
            <p className="text-sm leading-relaxed text-foreground">
              {brief.summary}
            </p>
          ) : null}
          <BriefLines heading="Keep" lines={brief.preserve} />
          <BriefLines heading="Improve" lines={brief.redesign} />
          <BriefLines heading="You will receive" lines={brief.delivered} />
          {brief.note ? (
            <p className="text-2xs text-muted-foreground">{brief.note}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">
          The brief for this job is not available in this build.
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2">
        {record.status !== "draft" ? (
          <p className="text-2xs text-muted-foreground">
            Work has already started for this job.
          </p>
        ) : (
          <>
            <Button
              className="self-start"
              disabled={
                !onStart ||
                startState.status === "starting" ||
                startState.status === "waiting"
              }
              onClick={start}
              size="sm"
              type="button"
            >
              {startState.status === "starting" ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              ) : null}
              Start redesign
            </Button>
            {!onStart ? (
              <p className="text-2xs text-muted-foreground">
                Starting the redesign is not available in this build.
              </p>
            ) : null}
            {startState.status === "waiting" ? (
              <p
                aria-live="polite"
                className="flex items-center gap-1.5 text-2xs text-muted-foreground"
              >
                <Loader2 aria-hidden="true" className="size-3 animate-spin" />
                Waiting for the job record to confirm the start.
              </p>
            ) : null}
            {startState.status === "failed" ? (
              <span
                className="flex flex-wrap items-center gap-2 text-2xs text-destructive"
                role="alert"
              >
                <span>{startState.message}</span>
                <button
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={start}
                  type="button"
                >
                  Try again
                </button>
              </span>
            ) : null}
          </>
        )}
        <p className="text-2xs text-muted-foreground">
          A preview comes first. Publishing is a separate decision.
        </p>
      </div>
    </section>
  );
}
