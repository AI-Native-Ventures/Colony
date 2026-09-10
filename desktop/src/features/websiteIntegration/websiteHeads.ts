/**
 * Canonical Website Manager head state for the desktop UI.
 *
 * A head (kind 30203) is a relay-signed NIP-33 projection of one job row:
 * `d` = jobId, `h` = channel, `task`/`thread`/`instance`/`manifest`/
 * `generation`, two `p` tags (owner, coordinator), and the compact
 * `colony.website-review/v1` record as content. The UI renders only heads that
 * verify against the active relay self key, so a same-channel event signed by
 * anyone else is ignored.
 *
 * The module-level store is community+channel scoped, keeps the highest
 * generation per thread root, indexes thread root and review-card instance to
 * the job, and holds receipts for confirmation. It is reset through
 * `resetCommunityState()`.
 */

import { verifyEvent } from "nostr-tools/pure";

import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_WEBSITE_HEAD,
  KIND_WEBSITE_RECEIPT,
} from "@/shared/constants/kinds";

import type {
  WebsiteArtifactRef,
  WebsiteCaptures,
  WebsiteDecisionRecord,
  WebsiteHandoverAsset,
  WebsiteHandoverRecord,
  WebsiteJobStatus,
  WebsiteQaEvidence,
  WebsiteReviewRecord,
  WebsiteRevisionRecord,
  WebsiteStageEvidenceRecord,
  WebsiteStageName,
} from "@/features/website/types";

const HEX_64 = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TASK_ID_CHARS = 256;

const JOB_STATUSES: readonly WebsiteJobStatus[] = [
  "draft",
  "working",
  "readyForReview",
  "approved",
  "changesRequested",
  "handedOver",
];

const STAGE_NAMES: readonly WebsiteStageName[] = [
  "brief",
  "research",
  "designBuild",
  "review",
  "revision",
  "approval",
  "handover",
];

const EVIDENCE_KINDS = [
  "jobOutcome",
  "jobCheckpoint",
  "taskReport",
  "workEvent",
] as const;

const REVIEW_SCHEMA = "colony.website-review/v1";
const RECEIPT_SCHEMA = "colony.website-receipt/v1";

export type WebsiteHead = {
  eventId: string;
  jobId: string;
  channelId: string;
  taskId: string;
  threadRoot: string;
  instanceEventId: string;
  manifestEventId: string;
  generation: number;
  ownerPubkey: string;
  coordinatorPubkey: string;
  record: WebsiteReviewRecord;
  createdAt: number;
};

export type WebsiteReceiptView = {
  eventId: string;
  actionEventId: string;
  jobId: string;
  op: string;
  outcome: "applied" | "duplicate";
  generation: number;
  revision: number;
  headEventId: string;
  decisionId?: string;
};

export type WebsiteHeadParseResult =
  | { ok: true; value: WebsiteHead }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSignedEvent(event: RelayEvent): boolean {
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

export function normalizeWebsiteHex(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function singleTag(event: RelayEvent, name: string): string | null {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 && matches[0]?.length === 2
    ? (matches[0][1] ?? null)
    : null;
}

function parseArtifactRef(value: unknown): WebsiteArtifactRef | null {
  if (!isRecord(value)) return null;
  const url = value.url;
  const sha256 = value.sha256;
  if (typeof url !== "string" || url.length === 0) return null;
  if (typeof sha256 !== "string" || !HEX_64.test(sha256)) return null;
  return { url, sha256 };
}

function parseCaptures(value: unknown): WebsiteCaptures | null {
  if (!isRecord(value)) return null;
  const before = parseArtifactRef(value.before);
  const desktop = parseArtifactRef(value.desktop);
  const mobile = parseArtifactRef(value.mobile);
  if (!before || !desktop || !mobile) return null;
  return { before, desktop, mobile };
}

function parseQa(value: unknown): WebsiteQaEvidence | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const reviewer = value.reviewer;
  const revision = value.revision;
  const manifestSha256 = value.manifestSha256;
  const passed = value.passed;
  const reportEventId = value.reportEventId;
  const report = parseArtifactRef(value.report);
  if (typeof reviewer !== "string" || !HEX_64.test(reviewer)) return null;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return null;
  }
  if (typeof manifestSha256 !== "string" || !HEX_64.test(manifestSha256)) {
    return null;
  }
  if (typeof passed !== "boolean") return null;
  if (typeof reportEventId !== "string" || !HEX_64.test(reportEventId)) {
    return null;
  }
  if (!report) return null;
  return { reviewer, revision, manifestSha256, passed, reportEventId, report };
}

function parseRevision(value: unknown): WebsiteRevisionRecord | null {
  if (!isRecord(value)) return null;
  const revision = value.revision;
  const preview = parseArtifactRef(value.preview);
  const archive = parseArtifactRef(value.archive);
  const captures = parseCaptures(value.captures);
  const builtBy = value.builtBy;
  const sourceUrl = value.sourceUrl;
  const qa = parseQa(value.qa);
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return null;
  }
  if (!preview || !archive || !captures) return null;
  if (typeof builtBy !== "string" || !HEX_64.test(builtBy)) return null;
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return null;
  if (qa === null) return null;
  return {
    revision,
    preview,
    sourceUrl,
    archive,
    captures,
    builtBy,
    ...(qa ? { qa } : {}),
  };
}

function boundedNote(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || Array.from(value).length > 2_000) {
    return null;
  }
  return value;
}

function parseDecision(value: unknown): WebsiteDecisionRecord | null {
  if (!isRecord(value)) return null;
  const decisionId = value.decisionId;
  const kind = value.kind;
  const jobId = value.jobId;
  const taskId = value.taskId;
  const channel = value.channel;
  const revision = value.revision;
  const manifestSha256 = value.manifestSha256;
  const actor = value.actor;
  const note = boundedNote(value.note);
  if (typeof decisionId !== "string" || decisionId.length === 0) return null;
  if (kind !== "approve" && kind !== "requestChanges") return null;
  if (typeof jobId !== "string" || !UUID.test(jobId)) return null;
  if (
    typeof taskId !== "string" ||
    taskId.length === 0 ||
    Array.from(taskId).length > MAX_TASK_ID_CHARS
  ) {
    return null;
  }
  if (typeof channel !== "string" || !UUID.test(channel)) return null;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    return null;
  }
  if (typeof manifestSha256 !== "string" || !HEX_64.test(manifestSha256)) {
    return null;
  }
  if (typeof actor !== "string" || !HEX_64.test(actor)) return null;
  if (note === null) return null;
  return {
    decisionId,
    kind,
    jobId,
    taskId,
    channel,
    revision,
    manifestSha256,
    actor,
    ...(note !== undefined ? { note } : {}),
  };
}

function parseStageEvidence(
  value: unknown,
): WebsiteStageEvidenceRecord | null {
  if (!isRecord(value)) return null;
  const stage = value.stage;
  const revision = value.revision;
  const kind = value.kind;
  const eventId = value.eventId;
  if (
    typeof stage !== "string" ||
    !STAGE_NAMES.includes(stage as WebsiteStageName)
  ) {
    return null;
  }
  if (
    revision !== undefined &&
    (typeof revision !== "number" ||
      !Number.isSafeInteger(revision) ||
      revision < 1)
  ) {
    return null;
  }
  if (
    typeof kind !== "string" ||
    !EVIDENCE_KINDS.includes(kind as (typeof EVIDENCE_KINDS)[number])
  ) {
    return null;
  }
  if (typeof eventId !== "string" || !HEX_64.test(eventId)) return null;
  return {
    stage: stage as WebsiteStageName,
    ...(typeof revision === "number" ? { revision } : {}),
    kind: kind as WebsiteStageEvidenceRecord["kind"],
    eventId,
  };
}

function parseHandover(value: unknown): WebsiteHandoverRecord | null {
  if (!isRecord(value)) return null;
  const jobId = value.jobId;
  const taskId = value.taskId;
  const approvedRevision = value.approvedRevision;
  const approvedManifestSha256 = value.approvedManifestSha256;
  const sourceUrl = value.sourceUrl;
  const sourceArchive = parseArtifactRef(value.sourceArchive);
  const assetsValue = value.assets;
  const acceptedBy = value.acceptedBy;
  if (typeof jobId !== "string" || !UUID.test(jobId)) return null;
  if (
    typeof taskId !== "string" ||
    taskId.length === 0 ||
    Array.from(taskId).length > MAX_TASK_ID_CHARS
  ) {
    return null;
  }
  if (
    typeof approvedRevision !== "number" ||
    !Number.isSafeInteger(approvedRevision) ||
    approvedRevision < 1
  ) {
    return null;
  }
  if (
    typeof approvedManifestSha256 !== "string" ||
    !HEX_64.test(approvedManifestSha256)
  ) {
    return null;
  }
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return null;
  if (!sourceArchive || !Array.isArray(assetsValue)) return null;
  const assets: WebsiteHandoverAsset[] = [];
  for (const asset of assetsValue) {
    if (!isRecord(asset)) return null;
    const path = asset.path;
    const artifact = parseArtifactRef(asset.artifact);
    if (typeof path !== "string" || path.length === 0 || !artifact) return null;
    assets.push({ path, artifact });
  }
  if (typeof acceptedBy !== "string" || !HEX_64.test(acceptedBy)) return null;
  const accessRequest =
    value.accessRequest === undefined
      ? undefined
      : (() => {
          if (!isRecord(value.accessRequest)) return null;
          const text = value.accessRequest.text;
          const authoredBy = value.accessRequest.authoredBy;
          if (typeof text !== "string" || text.length === 0) return null;
          if (
            typeof authoredBy !== "string" ||
            !HEX_64.test(authoredBy)
          ) {
            return null;
          }
          return { text, authoredBy };
        })();
  if (accessRequest === null) return null;
  return {
    jobId,
    taskId,
    approvedRevision,
    approvedManifestSha256,
    sourceUrl,
    sourceArchive,
    assets,
    acceptedBy,
    ...(accessRequest ? { accessRequest } : {}),
  };
}

/**
 * Strict structural parse of the compact review record. The relay is the
 * authority on validity; this only guarantees the UI never renders a record
 * with missing or mistyped fields it reads, and keeps every bound bounded.
 */
export function parseWebsiteRecord(value: unknown): WebsiteReviewRecord | null {
  if (!isRecord(value)) return null;
  const schema = value.schema;
  const jobId = value.jobId;
  const taskId = value.taskId;
  const channel = value.channel;
  const threadRoot = value.threadRoot;
  const owner = value.owner;
  const coordinator = value.coordinator;
  const sourceUrl = value.sourceUrl;
  const status = value.status;
  const currentRevision = value.currentRevision;
  const revisionsValue = value.revisions;
  const approvalsValue = value.approvals;
  const decisionsValue = value.decisions;
  const stageEvidenceValue = value.stageEvidence;
  const activeApprovalId = value.activeApprovalId;
  if (schema !== REVIEW_SCHEMA) return null;
  if (typeof jobId !== "string" || !UUID.test(jobId)) return null;
  if (
    typeof taskId !== "string" ||
    taskId.length === 0 ||
    Array.from(taskId).length > MAX_TASK_ID_CHARS
  ) {
    return null;
  }
  if (typeof channel !== "string" || !UUID.test(channel)) return null;
  if (typeof threadRoot !== "string" || !HEX_64.test(threadRoot)) return null;
  if (typeof owner !== "string" || !HEX_64.test(owner)) return null;
  if (
    coordinator !== undefined &&
    (typeof coordinator !== "string" || !HEX_64.test(coordinator))
  ) {
    return null;
  }
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) return null;
  if (
    typeof status !== "string" ||
    !JOB_STATUSES.includes(status as WebsiteJobStatus)
  ) {
    return null;
  }
  if (
    typeof currentRevision !== "number" ||
    !Number.isSafeInteger(currentRevision) ||
    currentRevision < 0
  ) {
    return null;
  }
  if (!Array.isArray(revisionsValue)) return null;
  const revisions: WebsiteRevisionRecord[] = [];
  for (const entry of revisionsValue) {
    const revision = parseRevision(entry);
    if (!revision) return null;
    revisions.push(revision);
  }
  if (!Array.isArray(approvalsValue) || !Array.isArray(decisionsValue)) {
    return null;
  }
  const approvals: WebsiteDecisionRecord[] = [];
  for (const entry of approvalsValue) {
    const decision = parseDecision(entry);
    if (!decision) return null;
    approvals.push(decision);
  }
  const decisions: WebsiteDecisionRecord[] = [];
  for (const entry of decisionsValue) {
    const decision = parseDecision(entry);
    if (!decision) return null;
    decisions.push(decision);
  }
  if (!Array.isArray(stageEvidenceValue)) return null;
  const stageEvidence: WebsiteStageEvidenceRecord[] = [];
  for (const entry of stageEvidenceValue) {
    const evidence = parseStageEvidence(entry);
    if (!evidence) return null;
    stageEvidence.push(evidence);
  }
  if (
    activeApprovalId !== undefined &&
    (typeof activeApprovalId !== "string" || activeApprovalId.length === 0)
  ) {
    return null;
  }
  const handoverHistoryValue = value.handoverHistory;
  const handoverHistory: WebsiteHandoverRecord[] = [];
  if (handoverHistoryValue !== undefined) {
    if (!Array.isArray(handoverHistoryValue)) return null;
    for (const entry of handoverHistoryValue) {
      const handover = parseHandover(entry);
      if (!handover) return null;
      handoverHistory.push(handover);
    }
  }
  let handover: WebsiteHandoverRecord | undefined;
  if (value.handover !== undefined) {
    const parsed = parseHandover(value.handover);
    if (!parsed) return null;
    handover = parsed;
  }
  return {
    schema: REVIEW_SCHEMA,
    jobId,
    taskId,
    channel,
    threadRoot,
    owner,
    ...(typeof coordinator === "string" ? { coordinator } : {}),
    sourceUrl,
    status: status as WebsiteJobStatus,
    currentRevision,
    revisions,
    approvals,
    ...(typeof activeApprovalId === "string" ? { activeApprovalId } : {}),
    decisions,
    stageEvidence,
    ...(handoverHistory.length > 0 ? { handoverHistory } : {}),
    ...(handover ? { handover } : {}),
  };
}

export function parseWebsiteHead(
  event: RelayEvent,
  relaySelfPubkey: string,
): WebsiteHeadParseResult {
  if (event.kind !== KIND_WEBSITE_HEAD) {
    return { ok: false, reason: "not a website head" };
  }
  const relaySelf = normalizeWebsiteHex(relaySelfPubkey);
  if (!relaySelf || !HEX_64.test(relaySelf)) {
    return { ok: false, reason: "relay self key is unknown" };
  }
  if (normalizeWebsiteHex(event.pubkey) !== relaySelf) {
    return { ok: false, reason: "head is not relay-signed" };
  }
  if (!validSignedEvent(event)) {
    return { ok: false, reason: "head signature is invalid" };
  }
  const jobId = singleTag(event, "d");
  const channelId = singleTag(event, "h");
  const taskId = singleTag(event, "task");
  const threadRoot = singleTag(event, "thread");
  const instanceEventId = singleTag(event, "instance");
  const manifestEventId = singleTag(event, "manifest");
  const generationRaw = singleTag(event, "generation");
  const pTags = event.tags.filter(
    (tag) => tag[0] === "p" && tag.length === 2,
  );
  if (
    !jobId ||
    !UUID.test(jobId) ||
    !channelId ||
    !UUID.test(channelId) ||
    !taskId ||
    taskId.length === 0 ||
    Array.from(taskId).length > MAX_TASK_ID_CHARS ||
    !threadRoot ||
    !HEX_64.test(threadRoot) ||
    !instanceEventId ||
    !HEX_64.test(instanceEventId) ||
    !manifestEventId ||
    !HEX_64.test(manifestEventId) ||
    !generationRaw ||
    pTags.length !== 2
  ) {
    return { ok: false, reason: "head tags are invalid" };
  }
  const generation = Number(generationRaw);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    return { ok: false, reason: "head generation is invalid" };
  }
  const ownerPubkey = normalizeWebsiteHex(pTags[0]?.[1]);
  const coordinatorPubkey = normalizeWebsiteHex(pTags[1]?.[1]);
  if (!HEX_64.test(ownerPubkey) || !HEX_64.test(coordinatorPubkey)) {
    return { ok: false, reason: "head identities are invalid" };
  }
  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return { ok: false, reason: "head content is not JSON" };
  }
  const record = parseWebsiteRecord(content);
  if (!record) return { ok: false, reason: "head record is invalid" };
  if (
    normalizeWebsiteHex(record.jobId) !== jobId.toLowerCase() ||
    normalizeWebsiteHex(record.channel) !== channelId.toLowerCase() ||
    record.taskId !== taskId ||
    normalizeWebsiteHex(record.threadRoot) !== threadRoot.toLowerCase() ||
    normalizeWebsiteHex(record.owner) !== ownerPubkey ||
    (record.coordinator !== undefined &&
      normalizeWebsiteHex(record.coordinator) !== coordinatorPubkey)
  ) {
    return { ok: false, reason: "head record disagrees with its tags" };
  }
  return {
    ok: true,
    value: {
      eventId: event.id,
      jobId: jobId.toLowerCase(),
      channelId: channelId.toLowerCase(),
      taskId,
      threadRoot: threadRoot.toLowerCase(),
      instanceEventId: instanceEventId.toLowerCase(),
      manifestEventId: manifestEventId.toLowerCase(),
      generation,
      ownerPubkey,
      coordinatorPubkey,
      record,
      createdAt: event.created_at,
    },
  };
}

export function parseWebsiteReceipt(
  event: RelayEvent,
  relaySelfPubkey: string,
): WebsiteReceiptView | null {
  if (event.kind !== KIND_WEBSITE_RECEIPT) return null;
  const relaySelf = normalizeWebsiteHex(relaySelfPubkey);
  if (
    !relaySelf ||
    normalizeWebsiteHex(event.pubkey) !== relaySelf ||
    !validSignedEvent(event)
  ) {
    return null;
  }
  const actionTag = event.tags.find(
    (tag) => tag[0] === "e" && tag[3] === "website-action",
  );
  const actionEventId = actionTag?.[1]?.toLowerCase() ?? "";
  if (!HEX_64.test(actionEventId)) return null;
  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!isRecord(content)) return null;
  if (content.schema !== RECEIPT_SCHEMA) return null;
  const jobId = content.jobId;
  const generation = content.generation;
  const revision = content.revision;
  const headEventId = content.headEventId;
  const op = content.op;
  const outcome = content.outcome;
  const decisionId = content.decisionId;
  if (typeof jobId !== "string" || !UUID.test(jobId)) return null;
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1
  ) {
    return null;
  }
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  ) {
    return null;
  }
  if (typeof headEventId !== "string" || !HEX_64.test(headEventId)) return null;
  if (typeof op !== "string" || op.length === 0) return null;
  if (outcome !== "applied" && outcome !== "duplicate") return null;
  if (
    decisionId !== undefined &&
    (typeof decisionId !== "string" || decisionId.length === 0)
  ) {
    return null;
  }
  return {
    eventId: event.id,
    actionEventId,
    jobId: jobId.toLowerCase(),
    op,
    outcome,
    generation,
    revision,
    headEventId,
    ...(typeof decisionId === "string" ? { decisionId } : {}),
  };
}

type ChannelBucket = {
  heads: Map<string, WebsiteHead>;
  snapshot: readonly WebsiteHead[];
  indexedInstances: Map<string, string>;
};

function bucketKey(communityId: string, channelId: string): string {
  return `${communityId}\u0000${channelId}`;
}

/**
 * Community+channel scoped head store with a strictly increasing generation
 * guard per thread root, plus receipt waiters for transport confirmation.
 */
export class WebsiteHeadsStore {
  private readonly buckets = new Map<string, ChannelBucket>();
  private readonly receipts = new Map<string, WebsiteReceiptView>();
  private readonly receiptWaiters = new Map<
    string,
    Set<(receipt: WebsiteReceiptView | null) => void>
  >();
  private readonly listeners = new Set<() => void>();

  reset(): void {
    this.buckets.clear();
    this.receipts.clear();
    for (const waiters of this.receiptWaiters.values()) {
      for (const resolve of waiters) resolve(null);
    }
    this.receiptWaiters.clear();
    this.notify();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  channelHeads(
    communityId: string,
    channelId: string,
  ): readonly WebsiteHead[] {
    return this.buckets.get(bucketKey(communityId, channelId))?.snapshot ?? [];
  }

  headForThread(
    communityId: string,
    channelId: string,
    threadRoot: string,
  ): WebsiteHead | null {
    return (
      this.buckets
        .get(bucketKey(communityId, channelId))
        ?.heads.get(threadRoot) ?? null
    );
  }

  headForInstance(
    communityId: string,
    channelId: string,
    instanceEventId: string,
  ): WebsiteHead | null {
    const bucket = this.buckets.get(bucketKey(communityId, channelId));
    if (!bucket) return null;
    const threadRoot = bucket.indexedInstances.get(instanceEventId);
    return threadRoot ? (bucket.heads.get(threadRoot) ?? null) : null;
  }

  applyEvents(
    communityId: string,
    channelId: string,
    relaySelfPubkey: string,
    events: readonly RelayEvent[],
  ): void {
    for (const event of events) {
      this.applyEvent(communityId, channelId, relaySelfPubkey, event);
    }
  }

  applyEvent(
    communityId: string,
    channelId: string,
    relaySelfPubkey: string,
    event: RelayEvent,
  ): boolean {
    const parsed = parseWebsiteHead(event, relaySelfPubkey);
    if (!parsed.ok) return false;
    if (parsed.value.channelId !== channelId.toLowerCase()) return false;
    const bucket = this.ensureBucket(communityId, channelId);
    const existing = bucket.heads.get(parsed.value.threadRoot);
    if (existing && parsed.value.generation <= existing.generation) {
      return false;
    }
    if (existing) {
      bucket.indexedInstances.delete(existing.instanceEventId);
    }
    bucket.heads.set(parsed.value.threadRoot, parsed.value);
    bucket.indexedInstances.set(
      parsed.value.instanceEventId,
      parsed.value.threadRoot,
    );
    this.rebuildSnapshot(bucket);
    this.notify();
    return true;
  }

  applyReceipt(event: RelayEvent, relaySelfPubkey: string): boolean {
    const receipt = parseWebsiteReceipt(event, relaySelfPubkey);
    if (!receipt) return false;
    this.receipts.set(receipt.actionEventId, receipt);
    const waiters = this.receiptWaiters.get(receipt.actionEventId);
    if (waiters) {
      for (const resolve of [...waiters]) resolve(receipt);
      this.receiptWaiters.delete(receipt.actionEventId);
    }
    return true;
  }

  receiptFor(actionEventId: string): WebsiteReceiptView | null {
    return this.receipts.get(actionEventId) ?? null;
  }

  waitForReceipt(
    actionEventId: string,
    timeoutMs: number,
  ): Promise<WebsiteReceiptView | null> {
    const existing = this.receipts.get(actionEventId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const waiters =
        this.receiptWaiters.get(actionEventId) ??
        new Set<(receipt: WebsiteReceiptView | null) => void>();
      let settled = false;
      const settle = (receipt: WebsiteReceiptView | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        waiters.delete(settle);
        resolve(receipt);
      };
      const timer = window.setTimeout(() => settle(null), timeoutMs);
      waiters.add(settle);
      this.receiptWaiters.set(actionEventId, waiters);
    });
  }

  private ensureBucket(communityId: string, channelId: string): ChannelBucket {
    const key = bucketKey(communityId, channelId);
    const existing = this.buckets.get(key);
    if (existing) return existing;
    const bucket: ChannelBucket = {
      heads: new Map(),
      snapshot: [],
      indexedInstances: new Map(),
    };
    this.buckets.set(key, bucket);
    return bucket;
  }

  private rebuildSnapshot(bucket: ChannelBucket): void {
    bucket.snapshot = [...bucket.heads.values()].sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        left.eventId.localeCompare(right.eventId),
    );
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export const websiteHeadsStore = new WebsiteHeadsStore();

export function resetWebsiteHeadsState(): void {
  websiteHeadsStore.reset();
}
