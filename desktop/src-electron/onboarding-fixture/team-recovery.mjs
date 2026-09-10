// A fault in the isolated fixture database, never an owner deletion or a fabricated Team.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifySigned } from "./native-team.mjs";

const tag = (event, name) => {
  const values = event.tags.filter((entry) => entry[0] === name);
  assert.equal(values.length, 1);
  return values[0][1];
};

/** Match only the canonical private fixture scope and its existing native profile. */
export function recoveryScope(directory, account) {
  assert.ok(path.isAbsolute(directory));
  assert.match(
    path.basename(directory),
    /^colony-onboarding-joined-[a-zA-Z0-9]+$/,
  );
  assert.match(account.ownerPubkey, /^[a-f0-9]{64}$/);
  assert.equal(account.ownerPubkey.length, 64);
  const profile = createHash("sha256")
    .update(directory)
    .digest("hex")
    .slice(0, 16);
  assert.equal(
    account.relayUrl,
    `wss://horizon-labs.onboarding-${profile}.invalid`,
  );
  const nativeDirectory = path.join(
    os.homedir(),
    "Library/Application Support",
    `xyz.block.buzz.app.dev-electron.${profile}`,
    "agents",
  );
  const scopeHash = createHash("sha256")
    .update(account.ownerPubkey)
    .update("\0")
    .update(account.relayUrl)
    .digest("hex");
  return {
    nativeDirectory,
    retentionPath: path.join(nativeDirectory, "retention", `${scopeHash}.db`),
    teamId: `builtin-team:${createHash("sha256").update(account.relayUrl).digest("hex").slice(0, 8)}:company-coordination`,
    host: new URL(account.relayUrl).hostname,
  };
}

async function exactFile(file, limit) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink());
  assert.equal(await realpath(file), file);
  if (limit) assert.ok(info.size <= limit, "No truncated readiness log");
}

async function retainedTeam(retentionPath, owner, id) {
  await exactFile(retentionPath);
  const db = new DatabaseSync(retentionPath, {
    readOnly: true,
    enableDoubleQuotedStringLiterals: false,
  });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;");
    return db
      .prepare(
        "SELECT pending_sync,raw_event FROM persona_events WHERE kind=30176 AND pubkey=? AND d_tag=?",
      )
      .get(owner, id);
  } finally {
    db.close();
  }
}

/** Await real background publication, then remove just its exact live relay row. */
export async function loseSyncedFixtureTeam({
  directory,
  account,
  reader,
  relay,
}) {
  assert.equal(await realpath(directory), directory);
  const scope = recoveryScope(directory, account);
  const deadline = Date.now() + 75_000;
  let team;
  let retained;
  while (Date.now() < deadline) {
    const teams = (await reader.events(30176)).filter(
      (event) => event.pubkey === account.ownerPubkey,
    );
    assert.ok(
      teams.length <= 1,
      "Fresh fixture has no unrelated owner Team to remove",
    );
    if (teams.length) {
      team = verifySigned(teams[0], 30176, account.ownerPubkey);
      assert.equal(tag(team, "d"), scope.teamId);
      const content = JSON.parse(team.content);
      assert.equal(content.lead_persona_id, "builtin:fizz");
      assert.ok(content.persona_ids.includes("builtin:fizz"));
      retained = await retainedTeam(
        scope.retentionPath,
        account.ownerPubkey,
        scope.teamId,
      );
      if (retained?.pending_sync === 0) {
        const local = verifySigned(
          JSON.parse(retained.raw_event),
          30176,
          account.ownerPubkey,
        );
        assert.equal(local.id, team.id);
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    team && retained?.pending_sync === 0,
    "Genuine Team must publish and finish native sync within the bounded fixture window",
  );
  assert.match(team.id, /^[a-f0-9]{64}$/);
  // This physical row loss is deliberately NOT NIP-09: native state stays synced.
  const removed = await relay.query(
    `WITH removed AS (DELETE FROM events WHERE community_id=(SELECT id FROM communities WHERE host='${scope.host}') AND kind=30176 AND pubkey=decode('${account.ownerPubkey}','hex') AND id=decode('${team.id}','hex') AND deleted_at IS NULL RETURNING id) SELECT count(*) FROM removed;`,
  );
  assert.equal(removed, "1");
  assert.equal(
    (await reader.events(30176)).filter(
      (event) => event.pubkey === account.ownerPubkey,
    ).length,
    0,
  );
  assert.deepEqual(
    await retainedTeam(scope.retentionPath, account.ownerPubkey, scope.teamId),
    retained,
    "Fault never changes the native synced row",
  );
  return {
    teamId: scope.teamId,
    originalEventId: team.id,
    originalContent: JSON.parse(team.content),
    nativePendingSync: 0,
    relayRowsRemoved: 1,
    ownerTeamHeadsAfterLoss: 0,
    boundary:
      "Physical loss of one real signed Team in the isolated relay; no owner deletion or local repair",
  };
}

/** Read only compact compile-gated readiness trace from this unique native profile. */
export async function readFixtureTeamReadiness(directory, account) {
  const scope = recoveryScope(directory, account);
  const file = path.join(
    scope.nativeDirectory,
    "first-job-team-readiness.jsonl",
  );
  await exactFile(file, 256 * 1024);
  const raw = await readFile(file, "utf8");
  assert.ok(Buffer.byteLength(raw) <= 256 * 1024);
  const lines = raw.trim().split("\n");
  assert.ok(lines.length <= 64);
  return lines.map((line) => {
    assert.ok(Buffer.byteLength(line) < 4096);
    const value = JSON.parse(line);
    // Explicit field projection prevents any future trace field entering evidence.
    return Object.fromEntries(
      [
        "ownerPubkey",
        "relayUrl",
        "sendId",
        "initialMissing",
        "submittedEventId",
        "verifiedEventId",
      ].map((field) => [field, value[field]]),
    );
  });
}

/** Validate scoped native ordering evidence against actual signed Team and Task records. */
export function validateFixtureTeamRecovery({
  account,
  loss,
  task,
  traces,
  teams,
  evidence,
}) {
  const matching = traces.filter(
    (trace) =>
      trace.ownerPubkey === account.ownerPubkey &&
      trace.relayUrl === account.relayUrl &&
      trace.sendId === account.suggestion.requestId,
  );
  assert.equal(
    matching.length,
    1,
    "One scoped native readiness transition before Task signing",
  );
  const trace = matching[0];
  assert.equal(
    trace.initialMissing,
    true,
    "Background publication did not hide the injected loss before scoped attach",
  );
  assert.match(trace.submittedEventId, /^[a-f0-9]{64}$/);
  assert.equal(trace.verifiedEventId, trace.submittedEventId);
  const matchingTeams = teams.filter(
    (event) =>
      event.pubkey === account.ownerPubkey && tag(event, "d") === loss.teamId,
  );
  assert.equal(matchingTeams.length, 1);
  const restored = verifySigned(matchingTeams[0], 30176, account.ownerPubkey);
  assert.equal(restored.id, trace.verifiedEventId);
  const content = JSON.parse(restored.content);
  for (const field of [
    "name",
    "description",
    "instructions",
    "lead_persona_id",
  ])
    assert.deepEqual(
      content[field],
      loss.originalContent[field],
      `Recovered Team preserves ${field}`,
    );
  for (const persona of loss.originalContent.persona_ids)
    assert.ok(content.persona_ids.includes(persona));
  assert.equal(task.owningTeamId, loss.teamId);
  assert.equal(evidence.taskRequests.length, 1);
  const { action, receipts } = evidence.taskRequests[0];
  // The trace is emitted before native Task signing. Nostr timestamps can be
  // deterministic/backdated and cannot establish this causal ordering.
  assert.equal(receipts.length, 1);
  assert.equal(
    receipts[0].tags.find((entry) => entry[0] === "company-receipt")[4],
    "applied",
  );
  return {
    ...loss,
    status: "recovered-before-task",
    trace,
    restoredEventId: restored.id,
    taskActionId: action.id,
    taskReceiptId: receipts[0].id,
  };
}

/** Require restoration before signed Task submission, not a lucky later background flush. */
export async function proveFixtureTeamRecovery({
  directory,
  account,
  reader,
  loss,
  task,
}) {
  return validateFixtureTeamRecovery({
    account,
    loss,
    task,
    traces: await readFixtureTeamReadiness(directory, account),
    teams: await reader.events(30176),
    evidence: await reader.failureEvidence(),
  });
}
