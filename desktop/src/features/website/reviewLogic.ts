/**
 * Pure review-state logic for the Website Manager viewing components.
 *
 * Mirrors the fail-closed rules in
 * `crates/buzz-core/src/website/review/lifecycle.rs`. Every function reads only
 * the canonical review record. Nothing here invents progress, approves
 * optimistically, or dispatches a decision: callers receive either an exact
 * decision payload or a typed refusal.
 */

import type {
  WebsiteDecisionKind,
  WebsiteDecisionRecord,
  WebsiteDecisionRequest,
  WebsiteReviewRecord,
  WebsiteRevisionRecord,
} from "./types";

export type WebsiteReasonCode =
  | "decision_pending"
  | "decision_payload_mismatch"
  | "stale_revision"
  | "revision_unknown"
  | "manifest_hash_mismatch"
  | "conflicting_decision"
  | "not_ready_for_review"
  | "not_pinned_owner"
  | "not_authorized"
  | "invalid_transition"
  | "qa_missing"
  | "qa_not_independent"
  | "qa_not_passed"
  | "qa_mismatch"
  | "note_required"
  | "note_too_long";

export type WebsiteEligibilityReason = {
  code: WebsiteReasonCode;
  message: string;
};

export type WebsiteDecisionEligibility = {
  canApprove: boolean;
  canRequestChanges: boolean;
  reasons: readonly WebsiteEligibilityReason[];
  /** Exact revision and manifest hash a decision would dispatch against. */
  matched: { revision: number; manifestSha256: string } | null;
};

/** Core counts note characters with Rust `chars()`, i.e. Unicode code points. */
export const WEBSITE_NOTE_MAX_CHARS = 2000;

export function countNoteCharacters(note: string): number {
  return Array.from(note).length;
}

export function findRevision(
  record: WebsiteReviewRecord,
  revision: number,
): WebsiteRevisionRecord | undefined {
  return record.revisions.find((entry) => entry.revision === revision);
}

export function validateQa(
  revision: WebsiteRevisionRecord,
):
  | { ok: true }
  | { ok: false; code: WebsiteReasonCode; message: string } {
  const qa = revision.qa;
  if (!qa) {
    return {
      ok: false,
      code: "qa_missing",
      message: "Independent QA has not been recorded for this version.",
    };
  }
  if (
    qa.revision !== revision.revision ||
    qa.manifestSha256 !== revision.preview.sha256
  ) {
    return {
      ok: false,
      code: "qa_mismatch",
      message: "QA evidence does not match this version.",
    };
  }
  if (qa.reviewer === revision.builtBy) {
    return {
      ok: false,
      code: "qa_not_independent",
      message: "The builder cannot review their own work.",
    };
  }
  if (qa.passed !== true) {
    return {
      ok: false,
      code: "qa_not_passed",
      message: "Independent QA has not passed for this version.",
    };
  }
  return { ok: true };
}

function conflictingDecision(
  record: WebsiteReviewRecord,
  revision: number,
  kind: WebsiteDecisionKind,
): boolean {
  return record.decisions.some(
    (decision) =>
      decision.revision === revision &&
      (decision.kind === kind ||
        (decision.kind === "requestChanges" && kind === "approve")),
  );
}

function decideForKind(
  record: WebsiteReviewRecord,
  revision: WebsiteRevisionRecord,
  kind: WebsiteDecisionKind,
): { allowed: boolean; reasons: WebsiteEligibilityReason[] } {
  const reasons: WebsiteEligibilityReason[] = [];
  if (kind === "approve") {
    if (record.status !== "readyForReview") {
      reasons.push({
        code: "not_ready_for_review",
        message: "This job is not ready for design approval.",
      });
    }
    const qa = validateQa(revision);
    if (!qa.ok) reasons.push({ code: qa.code, message: qa.message });
    if (conflictingDecision(record, revision.revision, kind)) {
      reasons.push({
        code: "conflicting_decision",
        message: "A decision has already been recorded for this version.",
      });
    }
    return { allowed: reasons.length === 0, reasons };
  }
  if (
    record.status !== "readyForReview" &&
    record.status !== "approved" &&
    record.status !== "handedOver"
  ) {
    reasons.push({
      code: "invalid_transition",
      message: "Changes can only be requested while a version is under review.",
    });
  }
  if (conflictingDecision(record, revision.revision, kind)) {
    reasons.push({
      code: "conflicting_decision",
      message: "Changes have already been requested for this version.",
    });
  }
  return { allowed: reasons.length === 0, reasons };
}

/**
 * Evaluate both decision controls for one explicit version selection. Refusal
 * flags are consistent: any blocking scope, pending, or revision problem turns
 * both controls off rather than only annotating a reason list.
 */
export function evaluateDecisionEligibility(input: {
  record: WebsiteReviewRecord;
  selectedRevision: number;
  actor: string;
  pending?: boolean;
}): WebsiteDecisionEligibility {
  const { record, selectedRevision, actor, pending } = input;
  const reasons: WebsiteEligibilityReason[] = [];
  const revision = findRevision(record, selectedRevision);

  if (pending) {
    reasons.push({
      code: "decision_pending",
      message: "A decision is already being recorded.",
    });
  }
  if (!revision) {
    reasons.push({
      code: "revision_unknown",
      message: "The selected version is not present in the review record.",
    });
    return {
      canApprove: false,
      canRequestChanges: false,
      reasons,
      matched: null,
    };
  }
  if (selectedRevision !== record.currentRevision) {
    reasons.push({
      code: "stale_revision",
      message:
        "This is an earlier version. Select the current version to decide on it.",
    });
  }

  const isOwner = actor === record.owner;
  const isCoordinator =
    Boolean(record.coordinator) && actor === record.coordinator;

  const approveCheck = decideForKind(record, revision, "approve");
  if (!isOwner) {
    approveCheck.reasons.unshift({
      code: "not_pinned_owner",
      message: "Only the pinned owner can approve the design.",
    });
  }
  const changesCheck = decideForKind(record, revision, "requestChanges");
  if (!isOwner && !isCoordinator) {
    changesCheck.reasons.unshift({
      code: "not_authorized",
      message: "Only the owner or coordinator can request changes.",
    });
  }

  const scopeBlocked =
    pending || !revision || selectedRevision !== record.currentRevision;
  for (const reason of approveCheck.reasons) {
    if (!reasons.some((entry) => entry.code === reason.code)) {
      reasons.push(reason);
    }
  }
  for (const reason of changesCheck.reasons) {
    if (!reasons.some((entry) => entry.code === reason.code)) {
      reasons.push(reason);
    }
  }

  // Authority is part of eligibility, not just an annotation: the stale
  // `allowed` value from decideForKind predates the ownership checks above.
  const canApprove = !scopeBlocked && approveCheck.allowed && isOwner;
  const canRequestChanges =
    !scopeBlocked && changesCheck.allowed && (isOwner || isCoordinator);
  const matched = scopeBlocked
    ? null
    : { revision: revision.revision, manifestSha256: revision.preview.sha256 };

  return { canApprove, canRequestChanges, reasons, matched };
}

/**
 * Build the exact `apply_decision` payload for a selection. Refusals mirror
 * core's codes so the UI never sends a decision core would reject.
 */
export function buildDecisionRequest(input: {
  record: WebsiteReviewRecord;
  kind: WebsiteDecisionKind;
  revision: number;
  manifestSha256: string;
  actor: string;
  note?: string;
}): { ok: true; request: WebsiteDecisionRequest } | {
  ok: false;
  code: WebsiteReasonCode;
  message: string;
} {
  const { record, kind, revision, manifestSha256, actor } = input;
  const note = input.note ?? "";

  const revisionRecord = findRevision(record, revision);
  if (!revisionRecord) {
    return {
      ok: false,
      code: "revision_unknown",
      message: "The selected version is not present in the review record.",
    };
  }
  if (countNoteCharacters(note) > WEBSITE_NOTE_MAX_CHARS) {
    return {
      ok: false,
      code: "note_too_long",
      message: `Feedback is limited to ${WEBSITE_NOTE_MAX_CHARS} characters.`,
    };
  }
  if (kind === "requestChanges" && note.trim().length === 0) {
    return {
      ok: false,
      code: "note_required",
      message: "Describe the changes you want before requesting them.",
    };
  }
  if (revision !== record.currentRevision) {
    return {
      ok: false,
      code: "stale_revision",
      message: "Only the current version can carry a decision.",
    };
  }
  if (manifestSha256 !== revisionRecord.preview.sha256) {
    return {
      ok: false,
      code: "manifest_hash_mismatch",
      message: "The decision must target the selected version's manifest hash.",
    };
  }
  if (conflictingDecision(record, revision, kind)) {
    return {
      ok: false,
      code: "conflicting_decision",
      message:
        kind === "approve"
          ? "An approval already exists for this version."
          : "Changes have already been requested for this version.",
    };
  }

  const isOwner = actor === record.owner;
  const isCoordinator =
    Boolean(record.coordinator) && actor === record.coordinator;
  if (kind === "approve") {
    if (record.status !== "readyForReview") {
      return {
        ok: false,
        code: "not_ready_for_review",
        message: "This job is not ready for design approval.",
      };
    }
    if (!isOwner) {
      return {
        ok: false,
        code: "not_pinned_owner",
        message: "Only the pinned owner can approve the design.",
      };
    }
    const qa = validateQa(revisionRecord);
    if (!qa.ok) return { ok: false, code: qa.code, message: qa.message };
  } else {
    if (!isOwner && !isCoordinator) {
      return {
        ok: false,
        code: "not_authorized",
        message: "Only the owner or coordinator can request changes.",
      };
    }
    if (
      record.status !== "readyForReview" &&
      record.status !== "approved" &&
      record.status !== "handedOver"
    ) {
      return {
        ok: false,
        code: "invalid_transition",
        message: "Changes can only be requested while a version is under review.",
      };
    }
  }

  const request: WebsiteDecisionRequest = {
    kind,
    jobId: record.jobId,
    taskId: record.taskId,
    channel: record.channel,
    revision: revisionRecord.revision,
    manifestSha256: revisionRecord.preview.sha256,
    actor,
    ...(countNoteCharacters(note) > 0 ? { note } : {}),
  };
  return { ok: true, request };
}

/**
 * Re-check a stored (failed) request against the current record before a
 * retry. A retry must be the exact same payload, still within scope, still
 * targeting the current revision and manifest, and still permitted for this
 * actor; otherwise it stays disabled instead of replaying stale work.
 */
export function revalidateDecisionRequest(input: {
  record: WebsiteReviewRecord;
  request: WebsiteDecisionRequest;
  actor: string;
}): { ok: true } | { ok: false; code: WebsiteReasonCode; message: string } {
  const { record, request, actor } = input;
  if (
    request.jobId !== record.jobId ||
    request.taskId !== record.taskId ||
    request.channel !== record.channel
  ) {
    return {
      ok: false,
      code: "invalid_transition",
      message: "This decision belongs to a different job.",
    };
  }
  if (request.actor !== actor) {
    return {
      ok: false,
      code: "not_authorized",
      message: "This decision was prepared by a different viewer.",
    };
  }
  const eligibility = evaluateDecisionEligibility({
    record,
    selectedRevision: request.revision,
    actor,
  });
  const allowed =
    request.kind === "approve"
      ? eligibility.canApprove
      : eligibility.canRequestChanges;
  if (!allowed || !eligibility.matched) {
    const reason = eligibility.reasons[0];
    return {
      ok: false,
      code: reason?.code ?? "invalid_transition",
      message: reason?.message ?? "This decision can no longer be sent.",
    };
  }
  if (
    eligibility.matched.revision !== request.revision ||
    eligibility.matched.manifestSha256 !== request.manifestSha256
  ) {
    return {
      ok: false,
      code: "manifest_hash_mismatch",
      message: "This decision no longer matches the current version.",
    };
  }
  return { ok: true };
}

export type WebsitePendingDecision = {
  request: WebsiteDecisionRequest;
  identityKey: string;
};

export type WebsitePendingResolution =
  | { status: "none" }
  | { status: "awaiting_record" }
  | { status: "recorded"; decision: WebsiteDecisionRecord }
  | {
      status: "conflict";
      code: WebsiteReasonCode;
      message: string;
      decision: WebsiteDecisionRecord;
    }
  | { status: "invalid"; code: WebsiteReasonCode; message: string };

/**
 * Canonical identity of a decision, with the feedback note deliberately
 * excluded (core derives `decisionId` the same way). Two dispatches with the
 * same key but a different note are the same decision identity and must be
 * treated as conflicting payloads, never as a successful replay.
 */
export function decisionIdentityKey(input: {
  jobId: string;
  taskId: string;
  channel: string;
  revision: number;
  kind: WebsiteDecisionKind;
  actor: string;
  manifestSha256: string;
}): string {
  return JSON.stringify([
    "colony.website.decision/v1",
    input.jobId,
    input.taskId,
    input.channel,
    input.revision,
    input.kind,
    input.actor,
    input.manifestSha256.toLowerCase(),
  ]);
}

/**
 * Full payload equality, including the note that identity derivation omits.
 * Mirrors `WebsiteDecision::matches_submission` in core.
 */
export function decisionRequestMatchesRecord(
  request: WebsiteDecisionRequest,
  decision: WebsiteDecisionRecord,
): boolean {
  return (
    decision.kind === request.kind &&
    decision.jobId === request.jobId &&
    decision.taskId === request.taskId &&
    decision.channel === request.channel &&
    decision.revision === request.revision &&
    decision.manifestSha256.toLowerCase() ===
      request.manifestSha256.toLowerCase() &&
    decision.actor === request.actor &&
    (decision.note ?? undefined) === (request.note ?? undefined)
  );
}

export function recordIdentityKey(decision: WebsiteDecisionRecord): string {
  return decisionIdentityKey(decision);
}

function pendingIdentityKey(pending: WebsitePendingDecision): string {
  return decisionIdentityKey(pending.request);
}

/**
 * Resolve a dispatched decision against the canonical record.
 *
 * The relay receipt is not success: this stays `awaiting_record` until the
 * record itself contains the decision. A same-identity record with a different
 * payload (for example a different note) is a conflict, never an old success.
 * A pending decision that no longer targets the current revision or manifest
 * is invalid; the UI must never apply it against a superseded version.
 */
export function resolvePendingDecision(input: {
  record: WebsiteReviewRecord;
  pending: WebsitePendingDecision | null;
}): WebsitePendingResolution {
  const { record, pending } = input;
  if (!pending) return { status: "none" };
  const identityKey = pendingIdentityKey(pending);
  const existing = record.decisions.find(
    (decision) => recordIdentityKey(decision) === identityKey,
  );
  if (existing) {
    if (decisionRequestMatchesRecord(pending.request, existing)) {
      return { status: "recorded", decision: existing };
    }
    return {
      status: "conflict",
      code: "decision_payload_mismatch",
      message:
        "A decision with this exact scope is already recorded with different feedback. Reload the job before sending another decision.",
      decision: existing,
    };
  }
  const head = findRevision(record, record.currentRevision);
  if (pending.request.revision !== record.currentRevision) {
    return {
      status: "invalid",
      code: "stale_revision",
      message:
        "The pending decision targets a version that is no longer current.",
    };
  }
  if (!head || pending.request.manifestSha256 !== head.preview.sha256) {
    return {
      status: "invalid",
      code: "manifest_hash_mismatch",
      message: "The pending decision no longer matches the current version.",
    };
  }
  return { status: "awaiting_record" };
}

/**
 * Reconcile an explicit version selection with a changed record. If the user
 * was on the head, the selection follows the new head; an explicit earlier
 * version stays where it was; a vanished revision falls back to the head.
 */
export function resolveSelectionAfterRecordChange(input: {
  previousCurrentRevision: number;
  nextCurrentRevision: number;
  nextRevisionNumbers: readonly number[];
  selectedRevision: number;
}): {
  revision: number;
  invalidated: boolean;
  followedHead: boolean;
  message?: string;
} {
  const {
    previousCurrentRevision,
    nextCurrentRevision,
    nextRevisionNumbers,
    selectedRevision,
  } = input;
  if (!nextRevisionNumbers.includes(selectedRevision)) {
    return {
      revision: nextCurrentRevision,
      invalidated: true,
      followedHead: true,
      message: "The selected version is no longer in the record.",
    };
  }
  if (
    selectedRevision === previousCurrentRevision &&
    previousCurrentRevision !== nextCurrentRevision
  ) {
    return {
      revision: nextCurrentRevision,
      invalidated: true,
      followedHead: true,
      message: "A newer version was recorded. Showing the current version.",
    };
  }
  return { revision: selectedRevision, invalidated: false, followedHead: false };
}
