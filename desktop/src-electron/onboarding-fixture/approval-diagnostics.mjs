import assert from "node:assert/strict";
import { verifySigned } from "./native-team.mjs";
import { wireEvent } from "./failure-diagnostics.mjs";

/** Project only the exact retained, signed public approval for this fixture scope. */
export function projectApprovalAttempt(saved, account) {
  if (saved === null) return { exists: false };
  const scope = {
    ownerPubkey: account.ownerPubkey,
    relayUrl: account.relayUrl,
    channelId: account.channelId,
    threadRootId: account.rootEventId,
    requestId: account.suggestion.requestId,
  };
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.scope, scope);
  const project = (event, marker) => {
    if (!event) return null;
    verifySigned(event, 9, scope.ownerPubkey);
    for (const expected of [
      ["h", scope.channelId],
      ["e", scope.threadRootId, "", "reply"],
      ["client", marker, scope.requestId],
    ])
      assert.deepEqual(
        event.tags.filter((tag) => tag[0] === expected[0]),
        [expected],
      );
    return wireEvent(event);
  };
  return {
    exists: true,
    approvalAcknowledged: saved.value.approvalAcknowledged === true,
    receiptAcknowledged: saved.value.receiptAcknowledged === true,
    approval: project(
      saved.value.approval,
      "colony:first-job-team-approval:v1",
    ),
    receipt: project(saved.value.receipt, "colony:first-job-team-receipt:v1"),
  };
}

/** Read one known local-storage key without publishing, retrying or exporting other state. */
export async function readApprovalAttempt(page, account) {
  const tuple = [
    account.ownerPubkey,
    account.relayUrl,
    account.channelId,
    account.rootEventId,
    account.suggestion.requestId,
    "team-approval",
  ];
  const saved = await page.evaluate((tuple) => {
    const raw = localStorage.getItem(
      `colony.first-job.v1:${JSON.stringify(tuple)}`,
    );
    if (raw === null) return null;
    if (raw.length > 131072)
      throw new Error("Approval diagnostic exceeds storage bound");
    return JSON.parse(raw);
  }, tuple);
  return projectApprovalAttempt(saved, account);
}
