import { randomBytes } from "node:crypto";
import path from "node:path";

import { normalizeRelay } from "../browser/managed-workers.mjs";
import {
  requireEvidenceId,
  requireEvidenceThreadRoot,
  requireEvidenceUuid,
} from "./policy.mjs";

const GENERATION_PATTERN = /^[a-f0-9]{32}$/;
const PUBKEY_PATTERN = /^[a-f0-9]{64}$/;

function normalizePubkey(value, label = "worker identity") {
  if (typeof value !== "string" || !PUBKEY_PATTERN.test(value.toLowerCase())) {
    throw new Error(`${label} is invalid`);
  }
  return value.toLowerCase();
}

function normalizedRelay(value, label = "relay") {
  try {
    return normalizeRelay(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
}

function currentContext(context) {
  if (context === null || typeof context !== "object") {
    throw new Error("No active business for evidence access");
  }
  const ownerPubkey = normalizePubkey(
    context.ownerPubkey ?? context.owner_pubkey,
    "owner identity",
  );
  const epoch = context.epoch ?? context.generation;
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new Error("The active business has no stable evidence epoch");
  }
  return {
    communityId: requireEvidenceId(context.id, "communityId"),
    relayUrl: normalizedRelay(context.relay),
    ownerPubkey,
    epoch,
  };
}

function sameContext(left, right) {
  return (
    left.communityId === right.communityId &&
    left.relayUrl === right.relayUrl &&
    left.ownerPubkey === right.ownerPubkey &&
    left.epoch === right.epoch
  );
}

function trustedWorkspace(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    !path.isAbsolute(value)
  )
    return null;
  const resolved = path.resolve(value);
  return path.isAbsolute(resolved) ? resolved : null;
}

/**
 * The same lifecycle facts used by managed browser sharing, with a stricter
 * job binding. Evidence access is available only to an owner-identified,
 * isolated, local, owner-only worker whose current process generation matches
 * the row returned by the authoritative native roster.
 */
export function isEligibleEvidenceWorker(row, relayUrl) {
  if (row === null || typeof row !== "object") return false;
  try {
    return (
      row.owner_identified === true &&
      row.isolated === true &&
      row.backend?.type === "local" &&
      row.status === "running" &&
      Number.isInteger(row.pid) &&
      row.pid > 0 &&
      typeof row.last_started_at === "string" &&
      row.last_started_at !== "" &&
      row.respond_to === "owner-only" &&
      row.needs_restart === false &&
      row.persona_orphaned !== true &&
      typeof row.browser_generation === "string" &&
      GENERATION_PATTERN.test(row.browser_generation) &&
      normalizedRelay(row.relay_url) === relayUrl
    );
  } catch {
    return false;
  }
}

function generationParts(value) {
  return {
    pid: value?.pid,
    started: value?.started ?? value?.last_started_at,
    generation: value?.generation ?? value?.browser_generation,
  };
}

function sameGeneration(left, right) {
  const current = generationParts(left);
  const expected = generationParts(right);
  return (
    current.pid !== undefined &&
    current.started !== undefined &&
    current.generation !== undefined &&
    expected.pid !== undefined &&
    expected.started !== undefined &&
    expected.generation !== undefined &&
    current.pid === expected.pid &&
    current.started === expected.started &&
    current.generation === expected.generation
  );
}

function findWorker(rows, workerPubkey) {
  return Array.isArray(rows)
    ? rows.find(
        (candidate) =>
          typeof candidate?.pubkey === "string" &&
          candidate.pubkey.toLowerCase() === workerPubkey,
      )
    : undefined;
}

function sameAssignment(left, right) {
  return [
    "workerPersonaId",
    "fingerprint",
    "websiteGeneration",
    "websiteRevision",
    "websiteManifestUrl",
    "websiteManifestSha256",
  ].every((field) => left?.[field] === right?.[field]);
}

function bindingAssignment(binding) {
  return {
    workerPersonaId: binding?.workerPersonaId,
    fingerprint: binding?.assignmentFingerprint,
    websiteGeneration: binding?.websiteGeneration,
    websiteRevision: binding?.websiteRevision,
    websiteManifestUrl: binding?.websiteManifestUrl,
    websiteManifestSha256: binding?.websiteManifestSha256,
  };
}

function sameRequestedScope(binding, requested, current) {
  return (
    binding?.communityId === requested.communityId &&
    binding?.relayUrl === requested.relayUrl &&
    binding?.ownerPubkey === current.ownerPubkey &&
    binding?.epoch === current.epoch &&
    binding?.jobId === requested.jobId &&
    binding?.taskId === requested.taskId &&
    binding?.channelId === requested.channelId &&
    binding?.workerPubkey === requested.workerPubkey &&
    binding?.threadRoot === requested.threadRoot
  );
}

function pendingIssueKey(requested, current, row) {
  return [
    requested.communityId,
    requested.relayUrl,
    current.ownerPubkey,
    current.epoch,
    requested.jobId,
    requested.taskId,
    requested.channelId,
    requested.workerPubkey,
    requested.threadRoot,
    row.pid,
    row.last_started_at,
    row.browser_generation,
  ].join("\u0000");
}

function grantResult(binding) {
  return Object.freeze({
    token: binding.token,
    communityId: binding.communityId,
    jobId: binding.jobId,
    taskId: binding.taskId,
    channelId: binding.channelId,
    workerPubkey: binding.workerPubkey,
    threadRoot: binding.threadRoot,
  });
}

function acceptAssignment(value, row) {
  if (value === null || typeof value !== "object" || value.authorized !== true)
    return null;
  if (
    typeof value.workerPersonaId !== "string" ||
    typeof row?.persona_id !== "string" ||
    value.workerPersonaId !== row.persona_id ||
    typeof value.fingerprint !== "string" ||
    value.fingerprint.length === 0
  )
    return null;
  return value;
}

/**
 * Issue and revalidate opaque per-worker, per-job evidence capabilities.
 * The native roster contributes only live-process facts; `assignment` must
 * return the signed task/Website authorization fingerprint and persona. The
 * class never accepts a worker name, filesystem path, cookie, or model-supplied
 * authority as proof of access.
 */
export class EvidenceAuthority {
  constructor({ context, roster, assignment, workspace }) {
    if (
      typeof context !== "function" ||
      typeof roster !== "function" ||
      typeof assignment !== "function" ||
      typeof workspace !== "function"
    ) {
      throw new Error(
        "EvidenceAuthority requires context, roster, assignment, and workspace functions",
      );
    }
    this.context = context;
    this.roster = roster;
    this.assignment = assignment;
    this.workspace = workspace;
    this.bindings = new Map();
    this.pendingIssues = new Map();
  }

  async findReusableBinding(requested, current, row) {
    // Validate the candidate instead of trusting its cached fingerprint. This
    // makes reuse prove the current signed Website/task assignment and native
    // worker generation before returning the existing token.
    for (const [token, binding] of [...this.bindings]) {
      if (
        !sameRequestedScope(binding, requested, current) ||
        !sameGeneration(row, binding)
      )
        continue;
      try {
        const reusable = await this.validate(token, requested);
        this.revokeSuperseded(requested, current, reusable.token);
        return reusable;
      } catch {
        // A stale assignment or workspace revokes the candidate. Continue so
        // issuance can establish one replacement binding for the same scope.
      }
    }
    return null;
  }

  revokeSuperseded(requested, current, keepToken) {
    for (const [token, binding] of [...this.bindings]) {
      if (
        token !== keepToken &&
        sameRequestedScope(binding, requested, current)
      )
        this.revoke(token);
    }
  }

  async issueAfterSnapshot(requested, current, row) {
    const reusable = await this.findReusableBinding(requested, current, row);
    if (reusable) return grantResult(reusable);

    const assignment = await this.assignment({
      ...requested,
      ownerPubkey: current.ownerPubkey,
      worker: row,
    });
    const afterAssignment = currentContext(this.context());
    if (!sameContext(current, afterAssignment)) {
      throw new Error("The business context changed during evidence access");
    }
    const authorization = acceptAssignment(assignment, row);
    if (!authorization) {
      throw new Error("The worker is not assigned to this evidence job");
    }
    const workspaceRoot = trustedWorkspace(
      await this.workspace({
        ...requested,
        ownerPubkey: current.ownerPubkey,
        worker: row,
        authorization,
      }),
    );
    const afterWorkspace = currentContext(this.context());
    if (!sameContext(current, afterWorkspace)) {
      throw new Error("The business context changed during evidence access");
    }
    if (workspaceRoot === null) {
      throw new Error("The assigned worker has no authorized workspace");
    }

    // The workspace resolver is an await boundary. Re-read both the signed
    // assignment and the native process generation after it so a worker that
    // restarted, changed persona, or lost the job cannot receive a token from
    // the earlier snapshot.
    const finalAssignment = await this.assignment({
      ...requested,
      ownerPubkey: current.ownerPubkey,
      worker: row,
    });
    const afterFinalAssignment = currentContext(this.context());
    if (!sameContext(current, afterFinalAssignment)) {
      throw new Error("The business context changed during evidence access");
    }
    const finalRows = await this.roster();
    const afterFinalRoster = currentContext(this.context());
    if (!sameContext(current, afterFinalRoster)) {
      throw new Error("The business context changed during evidence access");
    }
    const finalRow = findWorker(finalRows, requested.workerPubkey);
    if (
      !isEligibleEvidenceWorker(finalRow, requested.relayUrl) ||
      !sameGeneration(finalRow, row)
    ) {
      throw new Error("The worker lifecycle changed during evidence access");
    }
    const finalAuthorization = acceptAssignment(finalAssignment, finalRow);
    if (!finalAuthorization || !sameAssignment(finalAuthorization, authorization)) {
      throw new Error("The job assignment changed during evidence access");
    }

    // A restart or signed head update supersedes every old token for this
    // exact job/worker scope. This keeps stale capabilities from accumulating
    // while allowing the current fingerprint/generation to be reused above.
    this.revokeSuperseded(requested, current);
    const token = randomBytes(32).toString("hex");
    const binding = Object.freeze({
      token,
      ...requested,
      ownerPubkey: current.ownerPubkey,
      epoch: current.epoch,
      pid: row.pid,
      started: row.last_started_at,
      generation: row.browser_generation,
      workspaceRoot,
      assignmentFingerprint: finalAuthorization.fingerprint,
      workerPersonaId: finalAuthorization.workerPersonaId,
      websiteGeneration: finalAuthorization.websiteGeneration,
      websiteRevision: finalAuthorization.websiteRevision,
      websiteManifestUrl: finalAuthorization.websiteManifestUrl,
      websiteManifestSha256: finalAuthorization.websiteManifestSha256,
    });
    this.bindings.set(token, binding);
    return grantResult(binding);
  }

  async issue({
    communityId,
    relayUrl,
    jobId,
    taskId,
    channelId,
    workerPubkey,
    threadRoot,
  } = {}) {
    const requested = {
      communityId: requireEvidenceId(communityId, "communityId"),
      relayUrl: normalizedRelay(relayUrl),
      jobId: requireEvidenceUuid(jobId, "jobId"),
      taskId: requireEvidenceId(taskId, "taskId"),
      channelId: requireEvidenceUuid(channelId, "channelId"),
      workerPubkey: normalizePubkey(workerPubkey),
      threadRoot: requireEvidenceThreadRoot(threadRoot),
    };
    const current = currentContext(this.context());
    if (
      current.communityId !== requested.communityId ||
      current.relayUrl !== requested.relayUrl
    ) {
      throw new Error("Evidence scope does not match the active business");
    }
    const rows = await this.roster();
    const afterRoster = currentContext(this.context());
    if (!sameContext(current, afterRoster)) {
      throw new Error("The business context changed during evidence access");
    }
    const row = findWorker(rows, requested.workerPubkey);
    if (!isEligibleEvidenceWorker(row, requested.relayUrl)) {
      throw new Error(
        "Start an isolated, owner-only teammate with current settings before requesting evidence access",
      );
    }
    const key = pendingIssueKey(requested, current, row);
    const pending = this.pendingIssues.get(key);
    if (pending) return pending;
    const operation = this.issueAfterSnapshot(requested, current, row);
    this.pendingIssues.set(key, operation);
    return operation.finally(() => {
      if (this.pendingIssues.get(key) === operation) this.pendingIssues.delete(key);
    });
  }

  async validate(token, expected = {}) {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      throw new Error("Evidence access is invalid or revoked");
    }
    const binding = this.bindings.get(token);
    if (!binding) throw new Error("Evidence access is invalid or revoked");
    const current = currentContext(this.context());
    if (!sameContext(current, binding)) {
      this.revoke(token);
      throw new Error("Evidence access expired with the business context");
    }
    if (
      expected.communityId !== undefined &&
      expected.communityId !== binding.communityId
    ) {
      throw new Error("Evidence community scope mismatch");
    }
    if (expected.jobId !== undefined && expected.jobId !== binding.jobId) {
      throw new Error("Evidence job scope mismatch");
    }
    if (expected.taskId !== undefined && expected.taskId !== binding.taskId) {
      throw new Error("Evidence task scope mismatch");
    }
    if (
      expected.channelId !== undefined &&
      expected.channelId !== binding.channelId
    ) {
      throw new Error("Evidence channel scope mismatch");
    }
    if (
      expected.workerPubkey !== undefined &&
      normalizePubkey(expected.workerPubkey) !== binding.workerPubkey
    ) {
      throw new Error("Evidence worker scope mismatch");
    }
    if (
      expected.threadRoot !== undefined &&
      expected.threadRoot !== binding.threadRoot
    ) {
      throw new Error("Evidence thread scope mismatch");
    }
    const rows = await this.roster();
    const afterRoster = currentContext(this.context());
    if (!sameContext(current, afterRoster)) {
      this.revoke(token);
      throw new Error("Evidence access expired with the business context");
    }
    const row = findWorker(rows, binding.workerPubkey);
    if (!isEligibleEvidenceWorker(row, binding.relayUrl) || !sameGeneration(row, binding)) {
      this.revoke(token);
      throw new Error("Evidence access expired with the worker lifecycle");
    }
    const assignment = await this.assignment({
      communityId: binding.communityId,
      relayUrl: binding.relayUrl,
      jobId: binding.jobId,
      taskId: binding.taskId,
      channelId: binding.channelId,
      workerPubkey: binding.workerPubkey,
      threadRoot: binding.threadRoot,
      ownerPubkey: binding.ownerPubkey,
      worker: row,
    });
    const afterAssignment = currentContext(this.context());
    if (!sameContext(current, afterAssignment)) {
      this.revoke(token);
      throw new Error("Evidence access expired with the business context");
    }
    const authorization = acceptAssignment(assignment, row);
    if (!authorization) {
      this.revoke(token);
      throw new Error("Evidence access expired with the job assignment");
    }
    if (!sameAssignment(authorization, bindingAssignment(binding))) {
      this.revoke(token);
      throw new Error("Evidence access expired with the job assignment");
    }
    const workspaceRoot = trustedWorkspace(
      await this.workspace({
        communityId: binding.communityId,
        relayUrl: binding.relayUrl,
        jobId: binding.jobId,
        taskId: binding.taskId,
        channelId: binding.channelId,
        workerPubkey: binding.workerPubkey,
        threadRoot: binding.threadRoot,
        ownerPubkey: binding.ownerPubkey,
        worker: row,
        authorization,
      }),
    );
    const afterWorkspace = currentContext(this.context());
    if (!sameContext(current, afterWorkspace)) {
      this.revoke(token);
      throw new Error("Evidence access expired with the business context");
    }
    if (workspaceRoot !== binding.workspaceRoot) {
      this.revoke(token);
      throw new Error("Evidence access expired with the worker workspace");
    }

    // Do not let a restart or signed assignment update race the final return
    // after the workspace await. The old token is revoked and the caller can
    // reacquire against the new Website/task head when the worker is eligible.
    const finalAssignment = await this.assignment({
      communityId: binding.communityId,
      relayUrl: binding.relayUrl,
      jobId: binding.jobId,
      taskId: binding.taskId,
      channelId: binding.channelId,
      workerPubkey: binding.workerPubkey,
      threadRoot: binding.threadRoot,
      ownerPubkey: binding.ownerPubkey,
      worker: row,
    });
    const afterFinalAssignment = currentContext(this.context());
    if (!sameContext(current, afterFinalAssignment)) {
      this.revoke(token);
      throw new Error("Evidence access expired with the business context");
    }
    const finalRows = await this.roster();
    const afterFinalRoster = currentContext(this.context());
    if (!sameContext(current, afterFinalRoster)) {
      this.revoke(token);
      throw new Error("Evidence access expired with the business context");
    }
    const finalRow = findWorker(finalRows, binding.workerPubkey);
    if (
      !isEligibleEvidenceWorker(finalRow, binding.relayUrl) ||
      !sameGeneration(finalRow, binding)
    ) {
      this.revoke(token);
      throw new Error("Evidence access expired with the worker lifecycle");
    }
    const finalAuthorization = acceptAssignment(finalAssignment, finalRow);
    if (
      !finalAuthorization ||
      !sameAssignment(finalAuthorization, authorization)
    ) {
      this.revoke(token);
      throw new Error("Evidence access expired with the job assignment");
    }
    return binding;
  }

  /**
   * Synchronous fence for an operation that will perform host work. The
   * awaited `validate` call remains the authoritative roster and assignment
   * check; this fence catches a business switch before page work starts.
   */
  assertLive(token) {
    const binding = this.bindings.get(token);
    if (!binding) throw new Error("Evidence access is invalid or revoked");
    const current = currentContext(this.context());
    if (!sameContext(current, binding)) {
      this.revoke(token);
      throw new Error("Evidence access expired with the business context");
    }
    return binding;
  }

  revoke(token) {
    this.bindings.delete(token);
  }

  revokeAll() {
    this.bindings.clear();
  }
}
