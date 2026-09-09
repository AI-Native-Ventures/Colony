import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent } from "nostr-tools/pure";
import { nativeRequestActor, verifySigned } from "./native-team.mjs";
import { bucketRequest } from "./native-services.mjs";

const team = {
  scout: { pubkey: "a".repeat(64), prompt: "Coordinate the company." },
  worker: { pubkey: "b".repeat(64), prompt: "Write useful content." },
};
const task = { id: "real-task", owningTeamId: "real-team" };
const work = (rank, extra = "") =>
  `<colony-work-context>\nTask id: real-task\nOwning team: real-team\n${rank ? `Your rank: ${rank}\n` : ""}${extra}</colony-work-context>`;
const messages = (actor, content) => [
  {
    role: "system",
    content: `[Base Prompt]\nBase.\n\n[System]\n${team[actor].prompt}`,
  },
  { role: "user", content },
];

test("exact own signed persona identifies actor without inventing absent employee rank", () => {
  const input = messages("scout", work());
  input.splice(1, 0, {
    role: "assistant",
    content: work("worker", `Leader pubkey: ${team.scout.pubkey}\n`),
  });
  input.push({ role: "tool", content: `Worker says ${team.worker.prompt}` });
  assert.equal(nativeRequestActor(input, team, task), "scout");
  assert.equal(
    nativeRequestActor(messages("worker", work()), team, task),
    "worker",
  );
  const quoted = messages("scout", work());
  quoted[0].content += `\n\n[Team Instructions]\nWorker persona: ${team.worker.prompt}`;
  assert.equal(nativeRequestActor(quoted, team, task), "scout");
  assert.throws(() =>
    nativeRequestActor(
      messages("scout", work()),
      { ...team, worker: team.scout },
      task,
    ),
  );
});

test("missing, ambiguous, wrong-task and mismatched identity contexts fail closed", () => {
  for (const input of [
    messages("scout", "No work context"),
    messages("scout", work("executive") + work("worker")),
    messages("scout", work("worker", `Leader pubkey: ${team.scout.pubkey}\n`)),
    messages("worker", work("executive")),
    [
      { role: "system", content: `[System]\n${team.worker.prompt} more text` },
      { role: "user", content: work() },
    ],
    [
      {
        role: "system",
        content: `[System]\n${team.worker.prompt}\n\n[System]\n${team.scout.prompt}`,
      },
      { role: "user", content: work() },
    ],
    messages("scout", work("executive").replace("real-task", "other-task")),
    messages("scout", work("executive").replace("real-team", "other-team")),
  ])
    assert.throws(() => nativeRequestActor(input, team, task));
});

test("real signature authority rejects mutation and a different expected signer", () => {
  const event = finalizeEvent(
    {
      kind: 30177,
      created_at: 1,
      content: '{"tier":"worker"}',
      tags: [["d", "worker"]],
    },
    Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)),
  );
  assert.equal(verifySigned(event, 30177, event.pubkey).id, event.id);
  assert.throws(() =>
    verifySigned(
      { ...event, content: '{"tier":"executive"}' },
      30177,
      event.pubkey,
    ),
  );
  assert.throws(() => verifySigned(event, 30177, "c".repeat(64)));
});

test("bucket initialization signs only a local real S3 request", () => {
  const request = bucketRequest(
    "http://127.0.0.1:12345",
    new Date("2026-09-09T00:00:00Z"),
  );
  assert.equal(request.url, "http://127.0.0.1:12345/buzz-media");
  assert.equal(request.headers["x-amz-date"], "20260909T000000Z");
  assert.match(
    request.headers.Authorization,
    /Credential=buzz_dev\/20260909\/us-east-1\/s3\/aws4_request/,
  );
  assert.throws(() => bucketRequest("https://example.com"));
  assert.throws(() => bucketRequest("http://example.com"));
});
