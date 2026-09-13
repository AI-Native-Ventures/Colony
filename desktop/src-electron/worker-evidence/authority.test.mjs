import assert from "node:assert/strict";
import test from "node:test";

import { EvidenceAuthority, isEligibleEvidenceWorker } from "./authority.mjs";

const CONTEXT = {
  id: "community-1",
  relay: "wss://relay.example.com",
  ownerPubkey: "f".repeat(64),
  epoch: 1,
};
const PUBKEY = "a".repeat(64);

function row(overrides = {}) {
  return {
    pubkey: PUBKEY,
    owner_identified: true,
    isolated: true,
    backend: { type: "local" },
    status: "running",
    pid: 42,
    last_started_at: "2026-09-12T00:00:00.000Z",
    respond_to: "owner-only",
    needs_restart: false,
    persona_orphaned: false,
    browser_generation: "b".repeat(32),
    relay_url: CONTEXT.relay,
    persona_id: "builtin:research",
    working_dir: "/private/tmp/evidence-worker",
    ...overrides,
  };
}

function authority(
  current = CONTEXT,
  rows = [row()],
  assignment = () => ({
    authorized: true,
    workerPersonaId: "builtin:research",
    fingerprint: "stable-assignment",
  }),
  workspace = () => "/private/tmp/evidence-worker",
) {
  return new EvidenceAuthority({
    context: () => current,
    roster: async () => rows,
    assignment,
    workspace,
  });
}

const JOB = {
  communityId: CONTEXT.id,
  relayUrl: CONTEXT.relay,
  jobId: "11111111-1111-4111-8111-111111111111",
  taskId: "thread-task:website",
  channelId: "22222222-2222-4222-8222-222222222222",
  workerPubkey: PUBKEY,
  threadRoot: "c".repeat(64),
};

test("evidence eligibility requires the authoritative isolated owner-only lifecycle", () => {
  assert.equal(isEligibleEvidenceWorker(row(), CONTEXT.relay), true);
  for (const patch of [
    { owner_identified: false },
    { isolated: false },
    { backend: { type: "provider" } },
    { status: "stopped" },
    { respond_to: "anyone" },
    { needs_restart: true },
    { browser_generation: "" },
    { relay_url: "wss://other.example.com" },
  ]) {
    assert.equal(isEligibleEvidenceWorker(row(patch), CONTEXT.relay), false);
  }
});

test("the native workspace resolver is required and record working_dir is ignored", async () => {
  const auth = authority(CONTEXT, [row({ working_dir: "/worker-controlled" })]);
  const grant = await auth.issue(JOB);
  assert.equal(
    auth.bindings.get(grant.token).workspaceRoot,
    "/private/tmp/evidence-worker",
  );
  assert.throws(
    () =>
      new EvidenceAuthority({
        context: () => CONTEXT,
        roster: async () => [row()],
        assignment: () => ({
          authorized: true,
          workerPersonaId: "builtin:research",
          fingerprint: "stable-assignment",
        }),
      }),
    /workspace function/,
  );
});

test("capability is bound to one job and worker generation", async () => {
  const auth = authority();
  const grant = await auth.issue(JOB);
  assert.match(grant.token, /^[a-f0-9]{64}$/);
  assert.equal(grant.jobId, JOB.jobId);
  await assert.doesNotReject(() =>
    auth.validate(grant.token, { jobId: JOB.jobId }),
  );
  await assert.rejects(
    () => auth.validate(grant.token, { jobId: "other-job" }),
    /job scope mismatch/,
  );
});

test("repeated issuance reuses the current fingerprint and supersedes stale generations", async () => {
  const currentRows = [row()];
  let fingerprint = "task-head:website-head:1:builtin:research";
  const auth = authority(CONTEXT, currentRows, () => ({
    authorized: true,
    workerPersonaId: "builtin:research",
    fingerprint,
  }));

  const first = await auth.issue(JOB);
  const repeated = await auth.issue(JOB);
  assert.equal(repeated.token, first.token);
  assert.equal(auth.bindings.size, 1);

  fingerprint = "task-head:website-head:2:builtin:research";
  const updated = await auth.issue(JOB);
  assert.notEqual(updated.token, first.token);
  assert.equal(auth.bindings.size, 1);
  await assert.rejects(
    () => auth.validate(first.token),
    /invalid or revoked|job assignment/,
  );

  currentRows[0] = row({
    pid: 43,
    last_started_at: "2026-09-12T00:01:00.000Z",
    browser_generation: "c".repeat(32),
  });
  const restarted = await auth.issue(JOB);
  assert.notEqual(restarted.token, updated.token);
  assert.equal(auth.bindings.size, 1);
  await assert.rejects(
    () => auth.validate(updated.token),
    /invalid or revoked|worker lifecycle/,
  );
});

test("capability expires when the active business changes", async () => {
  let current = CONTEXT;
  const auth = authority(current);
  auth.context = () => current;
  const grant = await auth.issue(JOB);
  current = { ...CONTEXT, id: "other-community" };
  await assert.rejects(() => auth.validate(grant.token), /business context/);
  assert.equal(auth.bindings.size, 0);
});

test("capability requires an authoritative job assignment and workspace", async () => {
  const auth = authority(CONTEXT, [row()], () => false);
  await assert.rejects(() => auth.issue(JOB), /not assigned/);
  const noWorkspace = authority(CONTEXT, [row()], undefined, () => null);
  await assert.rejects(() => noWorkspace.issue(JOB), /authorized workspace/);
});

test("issuance refuses a worker restart during workspace resolution", async () => {
  const currentRows = [row()];
  const auth = authority(CONTEXT, currentRows, undefined, async () => {
    currentRows[0] = row({
      pid: 43,
      last_started_at: "2026-09-12T00:01:00.000Z",
      browser_generation: "c".repeat(32),
    });
    return "/private/tmp/evidence-worker";
  });
  await assert.rejects(
    () => auth.issue(JOB),
    /worker lifecycle changed during evidence access/,
  );
  assert.equal(auth.bindings.size, 0);
});

test("assignment identity and fingerprint are bound to the capability", async () => {
  let current = {
    authorized: true,
    workerPersonaId: "builtin:research",
    fingerprint: "task-event:website-event:1:builtin:research",
  };
  const auth = authority(CONTEXT, [row()], () => current);
  const grant = await auth.issue({
    ...JOB,
    taskId: "thread-task:website",
    channelId: JOB.channelId,
  });
  assert.equal(
    auth.bindings.get(grant.token).assignmentFingerprint,
    current.fingerprint,
  );
  await assert.doesNotReject(() => auth.validate(grant.token));
  current = { ...current, fingerprint: "new-head:builtin:research" };
  await assert.rejects(() => auth.validate(grant.token), /job assignment/);
  assert.equal(auth.bindings.size, 0);
});

test("capability expires when the signed current Website manifest changes", async () => {
  let current = {
    authorized: true,
    workerPersonaId: "builtin:research",
    fingerprint: "task-event:website-event:4:builtin:research",
    websiteGeneration: 4,
    websiteRevision: 4,
    websiteManifestUrl: "https://artifact.example.com/site-r4.json",
    websiteManifestSha256: "a".repeat(64),
  };
  const auth = authority(CONTEXT, [row()], () => current);
  const grant = await auth.issue({
    ...JOB,
    taskId: "thread-task:website",
    channelId: JOB.channelId,
  });

  current = {
    ...current,
    websiteManifestSha256: "b".repeat(64),
  };
  await assert.rejects(() => auth.validate(grant.token), /job assignment/);
  assert.equal(auth.bindings.size, 0);
});

test("context changes during an awaited roster read cannot mint a grant", async () => {
  let current = CONTEXT;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const auth = new EvidenceAuthority({
    context: () => current,
    roster: async () => {
      await pending;
      return [row()];
    },
    assignment: () => ({
      authorized: true,
      workerPersonaId: "builtin:research",
      fingerprint: "stable-assignment",
    }),
    workspace: () => "/private/tmp/evidence-worker",
  });
  const attempt = auth.issue(JOB);
  current = { ...CONTEXT, epoch: 2 };
  release();
  await assert.rejects(attempt, /context changed/);
  assert.equal(auth.bindings.size, 0);
});

test("capability expires when the worker restarts", async () => {
  const currentRows = [row()];
  const auth = authority(CONTEXT, currentRows);
  const grant = await auth.issue(JOB);
  currentRows[0] = row({
    pid: 43,
    last_started_at: "2026-09-12T00:01:00.000Z",
    browser_generation: "c".repeat(32),
  });
  await assert.rejects(() => auth.validate(grant.token), /worker lifecycle/);
  assert.equal(auth.bindings.size, 0);
});
