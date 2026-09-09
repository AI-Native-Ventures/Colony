import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent } from "nostr-tools/pure";
import {
  nativeRequestActor,
  personaAuthority,
  verifySigned,
} from "./native-team.mjs";
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

test("exact own verified persona identifies actor without inventing absent employee rank", () => {
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

test("built-in Scout authority stays local while a new worker requires its signed definition", () => {
  const keys = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0));
  const sign = (kind, id, content) =>
    finalizeEvent(
      {
        kind,
        created_at: 1,
        tags: [["d", id]],
        content: JSON.stringify(content),
      },
      keys,
    );
  const scout = {
    id: "builtin:fizz",
    is_builtin: true,
    is_active: true,
    role_id: "chief-of-staff",
    role_title: "Chief of Staff",
    system_prompt: "Coordinate.",
  };
  const scoutRecord = sign(30177, "a".repeat(64), {
    persona_id: scout.id,
    role_id: scout.role_id,
  });
  const common = {
    ownerPubkey: scoutRecord.pubkey,
    starterScout: { pubkey: "a".repeat(64), persona: scout },
  };
  const scoutArgs = {
    ...common,
    name: "scout",
    persona: { ...scout },
    record: scoutRecord,
    definition: null,
  };
  assert.equal(
    personaAuthority(scoutArgs).source,
    "unchanged native bundled builtin",
  );
  for (const change of [
    { id: "custom-scout" },
    { is_builtin: false },
    { is_active: false },
    { role_title: "Other" },
    { system_prompt: "Changed after approval." },
  ])
    assert.throws(() =>
      personaAuthority({ ...scoutArgs, persona: { ...scout, ...change } }),
    );
  assert.throws(() =>
    personaAuthority({
      ...scoutArgs,
      starterScout: { ...common.starterScout, pubkey: "b".repeat(64) },
    }),
  );
  const worker = {
    id: "approved-worker",
    is_builtin: false,
    system_prompt: "Write.",
  };
  const definition = sign(30175, worker.id, {
    system_prompt: worker.system_prompt,
  });
  const workerArgs = {
    ...common,
    name: "worker",
    persona: worker,
    record: sign(30177, "b".repeat(64), { persona_id: worker.id }),
    definition,
    action: {
      requestId: worker.id,
      definition: { systemPrompt: worker.system_prompt },
    },
  };
  assert.equal(personaAuthority(workerArgs).eventId, definition.id);
  assert.throws(() => personaAuthority({ ...workerArgs, definition: null }));
  assert.throws(() =>
    personaAuthority({
      ...workerArgs,
      definition: sign(30175, "other-worker", {
        system_prompt: worker.system_prompt,
      }),
    }),
  );
  assert.throws(() =>
    personaAuthority({
      ...workerArgs,
      definition: {
        ...definition,
        content: JSON.stringify({ system_prompt: "Changed." }),
      },
    }),
  );
  assert.throws(() =>
    personaAuthority({
      ...workerArgs,
      action: {
        ...workerArgs.action,
        definition: { systemPrompt: "Unapproved." },
      },
    }),
  );
});
