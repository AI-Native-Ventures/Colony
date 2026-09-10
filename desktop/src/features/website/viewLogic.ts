/**
 * Pure view models for the Website Manager panels: QA evidence, handover
 * resources, and factual work stages. Everything derives from the canonical
 * review record plus injected canonical data. Nothing here fabricates a
 * screenshot, report, pass, or stage.
 */

import {
  qaReportAgreesWithResult,
  qaReportScopeMatches,
  type WebsiteQaReport,
  type WebsiteQaReportResult,
} from "./qaReport";
import { findRevision, validateQa } from "./reviewLogic";
import type { WebsiteEligibilityReason, WebsiteReasonCode } from "./reviewLogic";
import type {
  WebsiteAgentDirectory,
  WebsiteArtifactRef,
  WebsiteDecisionRecord,
  WebsiteHandoverRecord,
  WebsiteProgressInput,
  WebsiteReviewRecord,
  WebsiteRevisionRecord,
  WebsiteStageEvidenceRecord,
  WebsiteStageName,
  WebsiteStageRow,
} from "./types";

/**
 * Loaded state of the reviewer report artifact. `unavailable` means the
 * integration supplied no report loader; the UI then links the report artifact
 * honestly instead of inventing a checklist.
 */
export type WebsiteQaReportState =
  | { status: "unavailable"; message: string }
  | { status: "loading" }
  | { status: "ready"; report: WebsiteQaReport }
  | { status: "error"; message: string; diagnostics?: string };

export type WebsiteQaCheck = {
  id: string;
  label: string;
  result: WebsiteQaReportResult;
  detail?: string;
  evidence: readonly WebsiteArtifactRef[];
};

export type WebsiteQaView = {
  /** QA evidence is attached to this revision. */
  present: boolean;
  /** The independently authenticated backend result (`qa.passed`). */
  recordedPassed: boolean;
  /**
   * The result to present: `recordedPassed` unless the checklist contradicts
   * it, in which case the UI must not present a pass.
   */
  displayPassed: boolean;
  independent: boolean;
  manifestMatches: boolean;
  reviewerPubkey?: string;
  reportEventId?: string;
  report?: WebsiteArtifactRef;
  /** A parsed, in-scope report supplied the checklist below. */
  reportLoaded: boolean;
  /** The checklist agrees with the recorded result. */
  reportAgrees: boolean;
  /** True when the loaded checklist contains a failed check. */
  hasFailedChecks: boolean;
  /** Reviewer-authored checks only. Never inferred from hashes or references. */
  checks: readonly WebsiteQaCheck[];
  /** Why no checklist can be shown, when `checks` is empty. */
  checksUnavailableReason?: string;
  /** Technical facts for a diagnostics disclosure, not the main checklist. */
  diagnostics: readonly { label: string; value: string }[];
};

/**
 * Resolve the QA panel for one revision. The checklist comes only from the
 * fetched, hash-verified, exact-revision report. Technical plumbing (event id,
 * hashes) is kept in `diagnostics`.
 */
export function resolveQaView(input: {
  revision: WebsiteRevisionRecord | undefined;
  report: WebsiteQaReportState;
}): WebsiteQaView {
  const { revision, report } = input;
  const qa = revision?.qa;
  const independent = Boolean(qa && qa.reviewer !== revision?.builtBy);
  const manifestMatches = Boolean(
    qa &&
      revision &&
      qa.revision === revision.revision &&
      qa.manifestSha256 === revision.preview.sha256,
  );
  const diagnostics: { label: string; value: string }[] = [];
  if (qa) {
    diagnostics.push({ label: "Reviewer", value: qa.reviewer });
    diagnostics.push({ label: "Reported version", value: String(qa.revision) });
    diagnostics.push({ label: "Reported manifest", value: qa.manifestSha256 });
    diagnostics.push({ label: "Report event", value: qa.reportEventId });
    diagnostics.push({ label: "Report artifact", value: qa.report.sha256 });
  }

  let checks: WebsiteQaCheck[] = [];
  let reportLoaded = false;
  let reportAgrees = true;
  let checksUnavailableReason: string | undefined;
  if (!qa || !revision) {
    checksUnavailableReason = "No independent review is recorded for this version.";
  } else if (report.status === "loading") {
    checksUnavailableReason = "The reviewer checklist is loading.";
  } else if (report.status === "unavailable") {
    checksUnavailableReason = report.message;
  } else if (report.status === "error") {
    checksUnavailableReason = report.message;
  } else {
    const scope = qaReportScopeMatches({
      report: report.report,
      reviewer: qa.reviewer,
      revision: revision.revision,
      manifestSha256: revision.preview.sha256,
    });
    if (!scope.ok) {
      checksUnavailableReason = scope.message;
    } else {
      reportLoaded = true;
      checks = report.report.checks.map((check) => ({
        id: check.id,
        label: check.label,
        result: check.result,
        detail: check.detail,
        evidence: check.evidence,
      }));
      const agreement = qaReportAgreesWithResult(report.report, qa.passed);
      reportAgrees = agreement.agrees;
      if (!agreement.agrees) {
        checksUnavailableReason = undefined;
        diagnostics.push({ label: "Checklist", value: agreement.message });
      }
    }
  }

  const recordedPassed = qa?.passed === true;
  const hasFailedChecks = checks.some((check) => check.result === "fail");
  const displayPassed =
    recordedPassed && (reportLoaded ? reportAgrees : true) && !hasFailedChecks;

  return {
    present: Boolean(qa),
    recordedPassed,
    displayPassed,
    independent,
    manifestMatches,
    reviewerPubkey: qa?.reviewer,
    reportEventId: qa?.reportEventId,
    report: qa?.report,
    reportLoaded,
    reportAgrees,
    hasFailedChecks,
    checks,
    checksUnavailableReason:
      checks.length === 0 ? checksUnavailableReason : undefined,
    diagnostics,
  };
}

export type WebsiteHandoverResource = {
  id: string;
  label: string;
  kind: "page" | "artifact";
  url: string;
  sha256?: string;
};

export type WebsiteHandoverView =
  | {
      kind: "blocked";
      reasons: readonly WebsiteEligibilityReason[];
      publishes: false;
      /** Every handover ever recorded, newest last. */
      history: readonly WebsiteHandoverRecord[];
    }
  | {
      kind: "approved";
      revision: WebsiteRevisionRecord;
      approvedBy?: string;
      approvalId?: string;
      resources: readonly WebsiteHandoverResource[];
      /** Manifest and other technical refs, shown only in a details disclosure. */
      technicalResources: readonly WebsiteHandoverResource[];
      publishes: false;
      history: readonly WebsiteHandoverRecord[];
    }
  | {
      kind: "handedOver";
      handover: WebsiteHandoverRecord;
      revision?: WebsiteRevisionRecord;
      resources: readonly WebsiteHandoverResource[];
      technicalResources: readonly WebsiteHandoverResource[];
      publishes: false;
      /** Handovers superseded by later reopen cycles, oldest first. */
      previous: readonly WebsiteHandoverRecord[];
    };

function revisionResources(
  revision: WebsiteRevisionRecord,
): {
  resources: WebsiteHandoverResource[];
  technicalResources: WebsiteHandoverResource[];
} {
  return {
    resources: [
      {
        id: "original-site",
        label: "Original website",
        kind: "page",
        url: revision.sourceUrl,
      },
      {
        id: "source-archive",
        label: "Approved source archive",
        kind: "artifact",
        url: revision.archive.url,
        sha256: revision.archive.sha256,
      },
      {
        id: "capture-desktop",
        label: "Desktop capture",
        kind: "artifact",
        url: revision.captures.desktop.url,
        sha256: revision.captures.desktop.sha256,
      },
      {
        id: "capture-mobile",
        label: "Mobile capture",
        kind: "artifact",
        url: revision.captures.mobile.url,
        sha256: revision.captures.mobile.sha256,
      },
    ],
    technicalResources: [
      {
        id: "preview-manifest",
        label: "Preview manifest",
        kind: "artifact",
        url: revision.preview.url,
        sha256: revision.preview.sha256,
      },
    ],
  };
}

function handoverResources(handover: WebsiteHandoverRecord): {
  resources: WebsiteHandoverResource[];
  technicalResources: WebsiteHandoverResource[];
} {
  const resources: WebsiteHandoverResource[] = [
    {
      id: "original-site",
      label: "Original website",
      kind: "page",
      url: handover.sourceUrl,
    },
    {
      id: "source-archive",
      label: "Approved source archive",
      kind: "artifact",
      url: handover.sourceArchive.url,
      sha256: handover.sourceArchive.sha256,
    },
  ];
  for (const asset of handover.assets) {
    resources.push({
      id: `asset:${asset.path}`,
      label: asset.path,
      kind: "artifact",
      url: asset.artifact.url,
      sha256: asset.artifact.sha256,
    });
  }
  return { resources, technicalResources: [] };
}

function allHandovers(
  record: WebsiteReviewRecord,
): readonly WebsiteHandoverRecord[] {
  return [
    ...(record.handoverHistory ?? []),
    ...(record.handover ? [record.handover] : []),
  ];
}

/**
 * Handover is separate from publication. The returned view always carries
 * `publishes: false`; there is deliberately no deploy or cutover action here.
 * A change request after handover reopens work while every stored handover
 * remains visible as history.
 */
export function resolveHandoverView(
  record: WebsiteReviewRecord,
): WebsiteHandoverView {
  const history = allHandovers(record);
  if (record.status === "handedOver" && record.handover) {
    const resources = handoverResources(record.handover);
    return {
      kind: "handedOver",
      handover: record.handover,
      revision: findRevision(record, record.handover.approvedRevision),
      resources: resources.resources,
      technicalResources: resources.technicalResources,
      publishes: false,
      previous: record.handoverHistory ?? [],
    };
  }
  const head = findRevision(record, record.currentRevision);
  const activeApproval = record.activeApprovalId
    ? record.approvals.find(
        (approval) => approval.decisionId === record.activeApprovalId,
      )
    : undefined;
  if (record.status === "handedOver" && !record.handover) {
    return {
      kind: "blocked",
      reasons: [
        {
          code: "invalid_transition" as WebsiteReasonCode,
          message: "This job is marked handed over but no handover is recorded.",
        },
      ],
      publishes: false,
      history,
    };
  }
  const reasons: WebsiteEligibilityReason[] = [];
  if (record.status !== "approved") {
    reasons.push({
      code: "not_ready_for_review" as WebsiteReasonCode,
      message: "Handover requires an approved design.",
    });
  }
  if (
    !activeApproval ||
    activeApproval.kind !== "approve" ||
    activeApproval.revision !== record.currentRevision ||
    !head ||
    activeApproval.manifestSha256 !== head.preview.sha256
  ) {
    reasons.push({
      code: "manifest_hash_mismatch" as WebsiteReasonCode,
      message: "The active approval does not match the current version.",
    });
  }
  if (reasons.length > 0 || !head) {
    return { kind: "blocked", reasons, publishes: false, history };
  }
  const resources = revisionResources(head);
  return {
    kind: "approved",
    revision: head,
    approvedBy: activeApproval?.actor,
    approvalId: activeApproval?.decisionId,
    resources: resources.resources,
    technicalResources: resources.technicalResources,
    publishes: false,
    history,
  };
}

export type WebsiteRevisionView =
  | { kind: "none" }
  | {
      kind: "requested";
      decision: WebsiteDecisionRecord;
      targetRevision: number;
    }
  | {
      kind: "addressed";
      decision: WebsiteDecisionRecord;
      targetRevision: number;
      currentRevision: number;
    };

/**
 * The latest change request in the record and whether a newer revision has
 * been recorded since. This never claims work is happening: `requested` means
 * the next version has not been recorded, `addressed` means it has.
 */
export function resolveRevisionView(
  record: WebsiteReviewRecord,
): WebsiteRevisionView {
  const requests = record.decisions.filter(
    (decision) => decision.kind === "requestChanges",
  );
  if (requests.length === 0) return { kind: "none" };
  const latest = requests[requests.length - 1];
  if (latest.revision < record.currentRevision) {
    return {
      kind: "addressed",
      decision: latest,
      targetRevision: latest.revision,
      currentRevision: record.currentRevision,
    };
  }
  return {
    kind: "requested",
    decision: latest,
    targetRevision: latest.revision,
  };
}

export type WebsiteStageDefinition = {
  id: string;
  stage: WebsiteStageName;
  label: string;
};

export const WEBSITE_STAGE_DEFINITIONS: readonly WebsiteStageDefinition[] = [
  { id: "research", stage: "research", label: "Understand the existing site" },
  { id: "design-build", stage: "designBuild", label: "Design and build" },
  {
    id: "independent-review",
    stage: "review",
    label: "Independent review",
  },
  { id: "owner-review", stage: "approval", label: "Owner review" },
];

const DECIDED_STATUSES: readonly string[] = [
  "readyForReview",
  "approved",
  "handedOver",
];

function evidenceFor(
  record: WebsiteReviewRecord,
  stage: WebsiteStageName,
): WebsiteStageEvidenceRecord[] {
  return record.stageEvidence.filter((entry) => entry.stage === stage);
}

type WebsiteStageFact = {
  done: boolean;
  detail: string;
  /** Set when every evidence record predates the current revision. */
  carriedForwardFrom?: number;
};

function carriedForwardFrom(
  evidence: readonly WebsiteStageEvidenceRecord[],
  currentRevision: number,
): number | undefined {
  if (evidence.length === 0 || currentRevision <= 1) return undefined;
  let newest = 0;
  for (const entry of evidence) {
    if (entry.revision === undefined) return undefined;
    newest = Math.max(newest, entry.revision);
  }
  return newest < currentRevision ? newest : undefined;
}

/**
 * The approval that authorizes the current revision, if any. A historical
 * approval must never keep the approval stage "done" once a newer revision is
 * current.
 */
export function activeApprovalForCurrentRevision(
  record: WebsiteReviewRecord,
): WebsiteReviewRecord["approvals"][number] | undefined {
  if (record.status !== "approved" && record.status !== "handedOver") {
    return undefined;
  }
  const approval = record.activeApprovalId
    ? record.approvals.find(
        (entry) => entry.decisionId === record.activeApprovalId,
      )
    : undefined;
  if (
    !approval ||
    approval.kind !== "approve" ||
    approval.revision !== record.currentRevision
  ) {
    return undefined;
  }
  const head = findRevision(record, record.currentRevision);
  if (!head || approval.manifestSha256 !== head.preview.sha256) return undefined;
  return approval;
}

function evidenceDetail(input: {
  done: boolean;
  count: number;
  empty: string;
  pending: string;
  carriedForwardFrom?: number;
}): string {
  const { done, count, empty, pending, carriedForwardFrom } = input;
  if (done) {
    if (count === 0) return "Confirmed complete by the job record.";
    if (carriedForwardFrom !== undefined) {
      return `Signed evidence from version ${carriedForwardFrom} still applies.`;
    }
    return `${count} signed evidence record${count === 1 ? "" : "s"}.`;
  }
  if (count > 0) return pending;
  return empty;
}

function stageFacts(
  record: WebsiteReviewRecord,
  completed: ReadonlySet<WebsiteStageName>,
): Record<WebsiteStageName, WebsiteStageFact> {
  const head = findRevision(record, record.currentRevision);
  const revisions = record.revisions.length;
  const qaValid = head ? validateQa(head).ok : false;
  const later = DECIDED_STATUSES.includes(record.status);
  const research = evidenceFor(record, "research");
  const designBuild = evidenceFor(record, "designBuild");
  const brief = evidenceFor(record, "brief");
  const researchCarried = completed.has("research")
    ? carriedForwardFrom(research, record.currentRevision)
    : undefined;
  const activeApproval = activeApprovalForCurrentRevision(record);
  return {
    brief: {
      done: completed.has("brief"),
      detail: evidenceDetail({
        done: completed.has("brief"),
        count: brief.length,
        empty: "No signed brief evidence recorded.",
        pending: "Brief evidence is recorded; completion is not yet confirmed.",
      }),
    },
    research: {
      done: completed.has("research"),
      detail: evidenceDetail({
        done: completed.has("research"),
        count: research.length,
        empty: "No signed research evidence recorded yet.",
        pending: "Signed evidence recorded; completion is not yet confirmed.",
        ...(researchCarried !== undefined
          ? { carriedForwardFrom: researchCarried }
          : {}),
      }),
      ...(researchCarried !== undefined
        ? { carriedForwardFrom: researchCarried }
        : {}),
    },
    designBuild: {
      done: revisions > 0 && later,
      detail:
        revisions > 0
          ? `${revisions} recorded revision${revisions === 1 ? "" : "s"}; ${designBuild.length} work evidence record${designBuild.length === 1 ? "" : "s"}.`
          : "No revision recorded yet.",
    },
    review: {
      done: qaValid && later,
      detail: head?.qa
        ? `Independent QA ${head.qa.passed ? "passed" : "did not pass"} for version ${head.qa.revision}.`
        : "No independent QA recorded yet.",
    },
    revision: {
      done: revisions > 0 && later,
      detail:
        revisions > 0
          ? "Revisions are listed on the design and build row."
          : "No revision recorded yet.",
    },
    approval: {
      done: Boolean(activeApproval),
      detail: activeApproval
        ? `Approval recorded for version ${activeApproval.revision}.`
        : record.approvals.length > 0
          ? `No approval is active for version ${record.currentRevision}.`
          : "No approval recorded yet.",
    },
    handover: {
      done: record.status === "handedOver" && Boolean(record.handover),
      detail: record.handover
        ? `Handover accepted for version ${record.handover.approvedRevision}.`
        : "No handover recorded yet.",
    },
  };
}

/**
 * Factual stage rows. Completion comes from explicit canonical completion
 * facts (`progress.completedStages`, the record's status, an active approval
 * for the current revision) and never from generic evidence presence or array
 * position; only canonical `activity` may label a stage "working".
 * Carried-forward evidence is labelled with its version rather than presented
 * as new work.
 */
export function deriveStageRows(input: {
  record: WebsiteReviewRecord;
  agents: WebsiteAgentDirectory;
  /** stage definition id to pubkey, from canonical assignment state. */
  stageAgents?: Readonly<Record<string, string>>;
  definitions?: readonly WebsiteStageDefinition[];
  /** Canonical completion facts and active work supplied by the adapter. */
  progress?: WebsiteProgressInput | null;
}): WebsiteStageRow[] {
  const { record, agents, stageAgents, progress } = input;
  const activity = progress?.activity ?? null;
  const completed = new Set(progress?.completedStages ?? []);
  const definitions = input.definitions ?? WEBSITE_STAGE_DEFINITIONS;
  const facts = stageFacts(record, completed);
  const head = findRevision(record, record.currentRevision);
  const reviewBlocked =
    record.status === "readyForReview" && (!head || !validateQa(head).ok);
  const firstOpen = definitions.findIndex(
    (entry) => !facts[entry.stage].done,
  );
  const states: WebsiteStageRow["state"][] = definitions.map(
    (entry, index) => {
      if (facts[entry.stage].done) return "done";
      if (
        activity &&
        activity.stage === entry.stage &&
        record.status !== "draft"
      ) {
        return "working";
      }
      if (entry.stage === "review" && reviewBlocked) return "blocked";
      if (index === firstOpen) return "next";
      return "then";
    },
  );

  return definitions.map((entry, index) => {
    const pubkey =
      stageAgents?.[entry.id] ??
      (entry.stage === "designBuild"
        ? head?.builtBy
        : entry.stage === "review"
          ? head?.qa?.reviewer
          : entry.stage === "approval"
            ? record.owner
            : undefined);
    const agent = pubkey ? agents.get(pubkey) : undefined;
    const fact = facts[entry.stage];
    const working = states[index] === "working";
    const detail =
      working && activity?.detail ? activity.detail : fact.detail;
    return {
      id: entry.id,
      stage: entry.stage,
      label: entry.label,
      state: states[index],
      agent,
      agentFallback: agent
        ? agent.name
        : entry.stage === "approval"
          ? "Owner"
          : "Not yet assigned",
      detail,
      evidence: evidenceFor(record, entry.stage),
      ...(fact.carriedForwardFrom !== undefined
        ? { carriedForwardFrom: fact.carriedForwardFrom }
        : {}),
    };
  });
}
