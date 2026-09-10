/**
 * Pure model for the read-only version inspection available while a revision
 * is being worked on. Opening a version is explicit; the current job state is
 * never replaced, and inspection is unavailable outside working states or for
 * a revision that is no longer in the record.
 */

import { scopedKey } from "./scopedAsync";
import type { WebsiteReviewRecord } from "./types";

export type WebsiteInspection = { revision: number } | null;

export function inspectionScopeKey(record: WebsiteReviewRecord): string {
  return scopedKey(record.channel, record.jobId, record.taskId, "inspect");
}

export function canInspectVersions(record: WebsiteReviewRecord): boolean {
  return (
    (record.status === "working" || record.status === "changesRequested") &&
    record.revisions.length > 0
  );
}

/**
 * Open one exact recorded revision. An unknown revision never replaces the
 * current selection, and inspection closes outside working states.
 */
export function openInspection(
  record: WebsiteReviewRecord,
  current: WebsiteInspection,
  revision: number,
): WebsiteInspection {
  if (!canInspectVersions(record)) return null;
  if (!record.revisions.some((entry) => entry.revision === revision)) {
    return current;
  }
  return { revision };
}

export function closeInspection(): WebsiteInspection {
  return null;
}

/**
 * The inspection that should actually render: null when inspection is not
 * available or the selected revision vanished from the record.
 */
export function visibleInspection(
  record: WebsiteReviewRecord,
  current: WebsiteInspection,
): WebsiteInspection {
  if (!canInspectVersions(record) || !current) return null;
  return record.revisions.some((entry) => entry.revision === current.revision)
    ? current
    : null;
}
