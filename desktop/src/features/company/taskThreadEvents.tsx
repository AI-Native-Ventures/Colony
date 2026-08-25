import type * as React from "react";

import { shortIdLabel } from "./workListModel";

/**
 * Task lifecycle system rows in a thread timeline.
 *
 * The relay authors these as kind 40099 system messages into the task's
 * source channel, tagged to the thread, with one of the payload types below.
 * Only seven transitions get a row - created, review handoff, review
 * rejected, bounce, completed, escalated, cancelled. A caption for every
 * status change turns the thread into a status log and buries the
 * conversation under it; these seven are the moments a reader needs.
 *
 * The desktop never synthesizes these rows from task heads: a row exists
 * because the relay signed one, which is what makes it history rather than a
 * projection of current state.
 */

export const TASK_TRANSITION_TYPES = [
  "task_created",
  "task_review_handoff",
  "task_review_rejected",
  "task_bounced",
  "task_completed",
  "task_escalated",
  "task_cancelled",
] as const;

export type TaskTransitionType = (typeof TASK_TRANSITION_TYPES)[number];

export function isTaskTransitionType(type: string): boolean {
  return (TASK_TRANSITION_TYPES as readonly string[]).includes(type);
}

const HEX_64 = /^[0-9a-f]{64}$/i;
const MAX_TEXT = 2_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= MAX_TEXT ? trimmed : null;
}

function optionalPubkey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return HEX_64.test(trimmed) ? trimmed : null;
}

export type TaskTransitionDescription = {
  /** Author slot in the row header: the owning team, or a neutral fallback. */
  author: string;
  action: React.ReactNode;
};

/**
 * Describe one relay-authored task transition payload.
 *
 * Returns null for anything malformed or unknown - a broken payload must not
 * render as a wrong sentence. `resolveName`, when given, turns an actor or
 * reviewer pubkey into display JSX; without it pubkeys render truncated.
 */
export function describeTaskTransition(
  payload: unknown,
  resolveName?: (pubkey: string) => React.ReactNode,
): TaskTransitionDescription | null {
  if (!isPlainObject(payload)) return null;
  const type = payload.type;
  const taskId = boundedText(payload.task);
  const title = boundedText(payload.title);
  if (
    typeof type !== "string" ||
    !isTaskTransitionType(type) ||
    !taskId ||
    !title
  ) {
    return null;
  }
  const reviewer = optionalPubkey(payload.reviewer);
  const team = boundedText(payload.team);
  const author = team ? shortIdLabel(team) : "Work";
  const name = (pubkey: string | null) =>
    pubkey ? (
      resolveName ? (
        resolveName(pubkey)
      ) : (
        <span className="break-all">{pubkey.slice(0, 8)}</span>
      )
    ) : null;

  switch (type as TaskTransitionType) {
    case "task_created":
      return {
        author,
        action: (
          <>
            created <strong>{title}</strong> from this message
          </>
        ),
      };
    case "task_review_handoff":
      return {
        author,
        action: (
          <>
            <strong>{title}</strong> is in review
            {reviewer ? <> &rarr; reviewer {name(reviewer)}</> : null}
          </>
        ),
      };
    case "task_review_rejected": {
      const issues =
        typeof payload.issues === "number" &&
        Number.isSafeInteger(payload.issues) &&
        payload.issues > 0
          ? payload.issues
          : null;
      return {
        author,
        action: (
          <>
            Review rejected on <strong>{title}</strong> &middot;{" "}
            {issues === null
              ? "issues left"
              : `${issues} issue${issues === 1 ? "" : "s"} to fix`}{" "}
            &middot; same task, same owner
          </>
        ),
      };
    }
    case "task_bounced": {
      const reason = boundedText(payload.reason);
      return {
        author,
        action: (
          <>
            Bounced back <strong>{title}</strong>
            {reason ? <> &ldquo;{reason}&rdquo;</> : null}
          </>
        ),
      };
    }
    case "task_completed":
      return {
        author,
        action: (
          <>
            <strong>{title}</strong> completed
          </>
        ),
      };
    case "task_escalated": {
      const reason = boundedText(payload.reason);
      return {
        author,
        action: (
          <>
            <strong>{title}</strong> escalated to a human
            {reason ? <> &ldquo;{reason}&rdquo;</> : null}
          </>
        ),
      };
    }
    case "task_cancelled":
      return {
        author,
        action: (
          <>
            <strong>{title}</strong> cancelled
          </>
        ),
      };
  }
}
