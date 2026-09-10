import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { finalizeEvent } from "nostr-tools/pure";
import {
  installNativePublishObserver,
  readNativePublishObservations,
} from "./native-publish-diagnostics.mjs";
import { projectApprovalAttempt } from "./approval-diagnostics.mjs";

test("native notices, closes, errors and both OK outcomes are bounded passive diagnostics", async () => {
  let callback;
  let unsubscribed = 0;
  const window = {
    colonyDesktop: {
      subscribe: (listener) => {
        callback = listener;
        return () => {
          unsubscribed += 1;
        };
      },
    },
  };
  runInNewContext(`(${installNativePublishObserver.toString()})({})`, {
    window,
  });
  const send = (type, data) =>
    callback(
      Object.freeze({
        type: "channel",
        id: 7,
        payload: Object.freeze({ type, data }),
      }),
    );
  const first = "a".repeat(64);
  send("Text", JSON.stringify(["OK", first, true, "saved"]));
  send("Text", JSON.stringify(["OK", "b".repeat(64), false, "refused"]));
  send(
    "Text",
    JSON.stringify([
      "NOTICE",
      "rate-limited: too many concurrent requests https://private.invalid key=nsec1secret",
    ]),
  );
  send("Close", Object.freeze({ code: 1001, reason: "going away" }));
  send("Error", "socket lost");
  send("Text", JSON.stringify(["AUTH", "never-export-auth"]));
  send(
    "Text",
    JSON.stringify([
      "EVENT",
      "private-subscription",
      { content: "never-export-content" },
    ]),
  );
  send("Text", '["NOTICE", invalid json');
  const page = {
    evaluate: async (fn) => runInNewContext(`(${fn.toString()})()`, { window }),
  };
  const observed = await readNativePublishObservations(page);
  assert.equal(observed.acknowledgements.length, 2);
  assert.equal(observed.acknowledgements[0].eventId, first);
  assert.equal(observed.acknowledgements[0].accepted, true);
  assert.equal(observed.acknowledgements[1].accepted, false);
  assert.deepEqual(
    Array.from(observed.lifecycle, (row) => row.type),
    ["NOTICE", "Close", "Error"],
  );
  assert.equal(observed.lifecycle[0].channelId, 7);
  assert.match(observed.lifecycle[0].message, /rate-limited/);
  assert.doesNotMatch(
    JSON.stringify(observed),
    /private.invalid|nsec1secret|never-export/,
  );
  assert.equal(unsubscribed, 1);
  assert.ok(observed.unavailable.length > 0);
});

test("native lifecycle overflow remains explicit without throwing to other consumers", () => {
  let callback;
  const window = {
    colonyDesktop: {
      subscribe: (listener) => {
        callback = listener;
        return () => {};
      },
    },
  };
  runInNewContext(`(${installNativePublishObserver.toString()})({})`, {
    window,
  });
  for (let i = 0; i < 45; i += 1)
    callback({
      type: "channel",
      payload: { type: "Text", data: '["NOTICE","busy"]' },
    });
  callback({
    type: "channel",
    payload: { type: "Error", data: "x".repeat(33000) },
  });
  const state = window.__COLONY_FIXTURE_NATIVE_PUBLISH_OBSERVER__.state;
  assert.equal(state.lifecycle.length, 40);
  assert.ok(state.unavailable.includes("lifecycle-limit"));
  assert.ok(state.unavailable.includes("lifecycle-message-limit"));
});

test("retained approval diagnostics require exact owner/root/request and a real signature", () => {
  const secret = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0));
  const root = "c".repeat(64);
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: 1,
      content: "I approve this synthetic team.",
      tags: [
        ["h", "channel"],
        ["e", root, "", "reply"],
        ["client", "colony:first-job-team-approval:v1", "request"],
      ],
    },
    secret,
  );
  const account = {
    ownerPubkey: event.pubkey,
    relayUrl: "wss://fixture.invalid",
    channelId: "channel",
    rootEventId: root,
    suggestion: { requestId: "request" },
  };
  const saved = {
    version: 1,
    scope: {
      ownerPubkey: event.pubkey,
      relayUrl: account.relayUrl,
      channelId: "channel",
      threadRootId: root,
      requestId: "request",
    },
    value: {
      approval: event,
      receipt: null,
      approvalAcknowledged: false,
      receiptAcknowledged: false,
      unrelated: "never-export",
    },
  };
  const result = projectApprovalAttempt(saved, account);
  assert.equal(result.approval.id, event.id);
  assert.equal(result.approvalAcknowledged, false);
  assert.equal(Object.keys(result.approval).length, 7);
  assert.doesNotMatch(JSON.stringify(result), /never-export/);
  for (const change of [
    { ownerPubkey: "a".repeat(64) },
    { rootEventId: "d".repeat(64) },
    { suggestion: { requestId: "other" } },
  ])
    assert.throws(() =>
      projectApprovalAttempt(saved, { ...account, ...change }),
    );
  assert.throws(() =>
    projectApprovalAttempt(
      {
        ...saved,
        value: { ...saved.value, approval: { ...event, content: "changed" } },
      },
      account,
    ),
  );
});
