/**
 * Canonical stage progress derived from the relay-signed head record.
 *
 * The relay validated every `stageEvidence` reference before the head was
 * signed, so a `taskReport`/`jobOutcome` entry completes its stage and stays
 * definitive even when an earlier `workEvent` was also recorded; a
 * `workEvent`/`jobCheckpoint` entry on its own only ever means "in progress".
 * Record facts cover the rest: the current revision completes design/build
 * (until a change request reopens it), its QA completes independent review, the
 * pinned active approval completes owner review, and `handedOver` completes
 * handover.
 *
 * Stage agents come from the same record: brief from the pinned coordinator,
 * design/build from the current revision's builder, review from the current
 * reviewer. Research stays unassigned because evidence carries event ids, not
 * agent ids; nothing is inferred from a persona name.
 */

import type {
  WebsiteProgressInput,
  WebsiteReviewRecord,
  WebsiteStageEvidenceKind,
  WebsiteStageName,
} from "@/features/website/types";
import { activeApprovalForCurrentRevision } from "@/features/website/viewLogic";

import type { WebsiteHead } from "./websiteHeads";

const DONE_EVIDENCE_KINDS: readonly WebsiteStageEvidenceKind[] = [
  "taskReport",
  "jobOutcome",
];

const ACTIVE_EVIDENCE_KINDS: readonly WebsiteStageEvidenceKind[] = [
  "workEvent",
  "jobCheckpoint",
];

const STAGE_ORDER: readonly WebsiteStageName[] = [
  "brief",
  "research",
  "designBuild",
  "review",
  "revision",
  "approval",
  "handover",
];

export function deriveWebsiteProgress(
  record: WebsiteReviewRecord,
): WebsiteProgressInput {
  const headRevision = record.revisions.find(
    (revision) => revision.revision === record.currentRevision,
  );
  const evidenceFor = (stage: WebsiteStageName) =>
    record.stageEvidence.filter((entry) => entry.stage === stage);
  const hasDoneEvidence = (stage: WebsiteStageName) =>
    evidenceFor(stage).some((entry) =>
      DONE_EVIDENCE_KINDS.includes(entry.kind),
    );
  const hasActiveEvidence = (stage: WebsiteStageName) =>
    evidenceFor(stage).some((entry) =>
      ACTIVE_EVIDENCE_KINDS.includes(entry.kind),
    );

  const completed = new Set<WebsiteStageName>();
  if (hasDoneEvidence("brief") && !hasActiveEvidence("brief")) {
    completed.add("brief");
  }
  // A completion report is definitive: an earlier work entry for the same
  // stage never reopens it. A change request reopens design and build, never
  // research.
  if (hasDoneEvidence("research")) {
    completed.add("research");
  }
  if (
    headRevision &&
    record.status !== "changesRequested" &&
    !hasActiveEvidence("designBuild")
  ) {
    completed.add("designBuild");
  }
  if (
    headRevision?.qa &&
    record.status !== "changesRequested" &&
    !hasActiveEvidence("review")
  ) {
    completed.add("review");
  }
  if (
    activeApprovalForCurrentRevision(record) &&
    !hasActiveEvidence("approval")
  ) {
    completed.add("approval");
  }
  if (record.status === "handedOver" && !hasActiveEvidence("handover")) {
    completed.add("handover");
  }

  const activeStage = STAGE_ORDER.find(
    (stage) => !completed.has(stage) && hasActiveEvidence(stage),
  );

  return {
    completedStages: [...completed],
    ...(activeStage ? { activity: { stage: activeStage } } : {}),
  };
}

/**
 * Stage definition id to pubkey, from the canonical record only. A stage with
 * no canonical owner is omitted so the feature shows its honest fallback.
 */
export function deriveWebsiteStageAgents(
  head: WebsiteHead,
): Readonly<Record<string, string>> | undefined {
  const record = head.record;
  const headRevision = record.revisions.find(
    (revision) => revision.revision === record.currentRevision,
  );
  const agents: Record<string, string> = {
    brief: head.coordinatorPubkey,
  };
  if (headRevision) {
    agents["design-build"] = headRevision.builtBy;
  }
  if (headRevision?.qa) {
    agents["independent-review"] = headRevision.qa.reviewer;
  }
  return Object.keys(agents).length > 0 ? agents : undefined;
}
