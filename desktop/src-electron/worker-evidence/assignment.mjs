import { normalizeRelay } from "../browser/managed-workers.mjs";
import {
  requireEvidenceId,
  requireEvidenceThreadRoot,
  requireEvidenceUuid,
  validateEvidenceUrl,
} from "./policy.mjs";

const PUBKEY_PATTERN = /^[a-f0-9]{64}$/;
const EVENT_ID_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ACTIVE_TASK_STATUSES = new Set(["ready", "inProgress", "inReview"]);
const ACTIVE_WEBSITE_STATUSES = new Set([
  "working",
  "readyForReview",
  "approved",
  "changesRequested",
]);

function pubkey(value, label) {
  if (typeof value !== "string" || !PUBKEY_PATTERN.test(value.toLowerCase()))
    throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function relay(value, label) {
  try {
    return normalizeRelay(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function uuid(value, label) {
  return requireEvidenceUuid(value, label);
}

function eventId(value, label) {
  if (typeof value !== "string" || !EVENT_ID_PATTERN.test(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function exact(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match evidence scope`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} is invalid`);
  return value;
}

function signedManifest(value, label) {
  const manifest = object(value, label);
  let url;
  try {
    url = validateEvidenceUrl(manifest.url).href;
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  if (typeof manifest.sha256 !== "string" || !SHA256_PATTERN.test(manifest.sha256))
    throw new Error(`${label} hash is invalid`);
  return Object.freeze({ url, sha256: manifest.sha256 });
}

function currentWebsiteManifest(website) {
  if (website.currentRevision === 0) return null;
  if (!Array.isArray(website.revisions))
    throw new Error("Website revision history is invalid");
  const matches = website.revisions.filter(
    (revision) => revision?.revision === website.currentRevision,
  );
  if (matches.length !== 1)
    throw new Error("Website current revision is missing its manifest");
  return signedManifest(
    matches[0].preview,
    "Website current revision manifest",
  );
}

/**
 * Validate the native snapshot that joins a live worker to a signed website
 * assignment. The caller supplied coordinates are only selectors for the
 * native read; this function accepts access only when the returned canonical
 * task and Website head agree with every coordinate.
 */
export function validateRelayTaskAssignment(snapshot, expected) {
  object(snapshot, "native assignment snapshot");
  object(expected, "evidence scope");
  const scope = {
    relayUrl: relay(expected.relayUrl, "evidence relay"),
    ownerPubkey: pubkey(expected.ownerPubkey, "evidence owner"),
    workerPubkey: pubkey(expected.workerPubkey, "evidence worker"),
    jobId: uuid(expected.jobId, "evidence job id"),
    taskId: requireEvidenceId(expected.taskId, "evidence task id"),
    channelId: uuid(expected.channelId, "evidence channel id"),
    threadRoot: requireEvidenceThreadRoot(expected.threadRoot),
  };

  exact(relay(snapshot.relayUrl, "native relay"), scope.relayUrl, "relay");
  exact(pubkey(snapshot.ownerPubkey, "native owner"), scope.ownerPubkey, "owner");
  exact(pubkey(snapshot.workerPubkey, "native worker"), scope.workerPubkey, "worker");
  exact(uuid(snapshot.jobId, "native job id"), scope.jobId, "job");
  exact(requireEvidenceId(snapshot.taskId, "native task id"), scope.taskId, "task");
  exact(uuid(snapshot.channelId, "native channel id"), scope.channelId, "channel");
  exact(
    requireEvidenceThreadRoot(snapshot.threadRoot),
    scope.threadRoot,
    "thread",
  );

  const taskEventId = eventId(snapshot.taskEventId, "task event id");
  const websiteEventId = eventId(snapshot.websiteEventId, "Website event id");
  if (!Number.isSafeInteger(snapshot.websiteGeneration) || snapshot.websiteGeneration < 1)
    throw new Error("Website generation is invalid");

  const task = object(snapshot.task, "canonical CompanyTask");
  exact(task.id, scope.taskId, "CompanyTask");
  exact(task.sourceChannelId, scope.channelId, "CompanyTask channel");
  exact(task.threadRoot, scope.threadRoot, "CompanyTask thread");
  if (!ACTIVE_TASK_STATUSES.has(task.status))
    throw new Error("CompanyTask is not active for evidence access");
  if (
    !Array.isArray(task.assigneePersonaIds) ||
    task.assigneePersonaIds.some((value) => typeof value !== "string") ||
    typeof task.qaPersonaId !== "string"
  )
    throw new Error("CompanyTask assignment is invalid");

  const website = object(snapshot.website, "canonical Website review");
  exact(uuid(website.jobId, "Website job id"), scope.jobId, "Website job");
  exact(website.taskId, scope.taskId, "Website task");
  exact(uuid(website.channel, "Website channel"), scope.channelId, "Website channel");
  exact(
    requireEvidenceThreadRoot(website.threadRoot),
    scope.threadRoot,
    "Website thread",
  );
  exact(pubkey(website.owner, "Website owner"), scope.ownerPubkey, "Website owner");
  if (
    !Number.isSafeInteger(website.currentRevision) ||
    website.currentRevision < 0
  )
    throw new Error("Website current revision is invalid");
  if (!ACTIVE_WEBSITE_STATUSES.has(website.status))
    throw new Error("Website job is not active for evidence access");
  const websiteManifest = currentWebsiteManifest(website);

  const workerPersonaId = requireEvidenceId(
    snapshot.workerPersonaId,
    "worker persona",
  );
  if (
    !task.assigneePersonaIds.includes(workerPersonaId) &&
    task.qaPersonaId !== workerPersonaId
  )
    throw new Error("the managed worker is not assigned to this CompanyTask");

  return Object.freeze({
    authorized: true,
    fingerprint: `${taskEventId}:${websiteEventId}:${snapshot.websiteGeneration}:${workerPersonaId}`,
    workerPersonaId,
    taskEventId,
    websiteEventId,
    websiteGeneration: snapshot.websiteGeneration,
    websiteRevision: website.currentRevision,
    ...(websiteManifest === null
      ? {}
      : {
          websiteManifestUrl: websiteManifest.url,
          websiteManifestSha256: websiteManifest.sha256,
        }),
  });
}

/**
 * Adapt the native Tauri read command to `EvidenceAuthority`'s assignment
 * callback. `read` must be the trusted renderer-to-native invoke path; no
 * worker supplied job label or assignment object is accepted as authority.
 */
export function createRelayTaskAssignmentResolver({ read }) {
  if (typeof read !== "function")
    throw new Error("A native assignment reader is required");
  return async (scope = {}) => {
    if (scope.taskId === undefined || scope.channelId === undefined)
      throw new Error("Evidence assignment requires a task and channel coordinate");
    const request = {
      relayUrl: scope.relayUrl,
      ownerPubkey: scope.ownerPubkey,
      jobId: scope.jobId,
      taskId: scope.taskId,
      channelId: scope.channelId,
      threadRoot: scope.threadRoot,
      workerPubkey: scope.workerPubkey,
    };
    const snapshot = await read(request);
    return validateRelayTaskAssignment(snapshot, request);
  };
}
