import test from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent } from "nostr-tools/pure";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { waitForTeamPreview } from "./diagnostics.mjs";
import {
  nativeRequestActor,
  personaAuthority,
  scopedFirstJobDefinitionId,
  taskFailureEvidence,
  verifySigned,
} from "./native-team.mjs";
import { bucketRequest } from "./native-services.mjs";
import { createOnboardingFixtureProvider } from "./provider.mjs";
import {
  observeEventResponse,
  projectIngestFailures,
} from "./failure-diagnostics.mjs";

test("passive refused response capture preserves streamed bytes and exact event correlation", async () => {
  const eventId = "a".repeat(64);
  const raw = JSON.stringify({
    accepted: false,
    event_id: eventId,
    message: "this company has no coordination team to own ambiguous work",
    privateField: "never-export-this",
  });
  const response = new PassThrough();
  const observations = [];
  const forwarded = [];
  observeEventResponse(response, (value) => observations.push(value));
  response.on("data", (chunk) => forwarded.push(chunk));
  const ended = once(response, "end");
  response.write(raw.slice(0, 24));
  response.end(raw.slice(24));
  await ended;
  assert.equal(
    Buffer.concat(forwarded).toString(),
    raw,
    "App receives original response bytes",
  );
  assert.deepEqual(observations, [
    {
      accepted: false,
      eventId,
      message: "this company has no coordination team to own ambiguous work",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(observations), /never-export-this/);
});

test("response observation marks unavailable reads explicitly and never buffers unbounded bodies", async () => {
  for (const [raw, expected] of [
    [
      JSON.stringify({ accepted: true, message: "never-export-this" }),
      { accepted: true },
    ],
    ["not JSON", { unavailable: "response-parse" }],
    [
      JSON.stringify({ accepted: false, event_id: "not-an-id", message: "x" }),
      { unavailable: "response-shape" },
    ],
    ["x".repeat(32 * 1024 + 1), { unavailable: "response-limit" }],
    [
      JSON.stringify({
        accepted: false,
        event_id: "a".repeat(64),
        message: "token=never-export-this",
      }),
      {
        accepted: false,
        eventId: "a".repeat(64),
        message: "[redacted-credential]",
      },
    ],
  ]) {
    const response = new PassThrough();
    const observations = [];
    const forwarded = [];
    observeEventResponse(response, (value) => observations.push(value));
    response.on("data", (chunk) => forwarded.push(chunk));
    const ended = once(response, "end");
    response.end(raw);
    await ended;
    assert.equal(Buffer.concat(forwarded).toString(), raw);
    assert.deepEqual(observations, [expected]);
  }
  const aborted = new PassThrough();
  const observations = [];
  observeEventResponse(aborted, (value) => observations.push(value));
  aborted.emit("aborted");
  aborted.destroy();
  assert.deepEqual(observations, [{ unavailable: "response-aborted" }]);
});

test("failure evidence binds signed task receipts to the exact owner and thread", () => {
  const ownerKey = Uint8Array.from({ length: 32 }, (_, i) =>
    i === 31 ? 1 : 0,
  );
  const relayKey = Uint8Array.from({ length: 32 }, (_, i) =>
    i === 31 ? 2 : 0,
  );
  const sign = (key, kind, tags, content) =>
    finalizeEvent(
      { kind, tags, content: JSON.stringify(content), created_at: 1 },
      key,
    );
  const owner = sign(ownerKey, 30176, [["d", "coordination"]], {
    persona_ids: ["builtin:fizz"],
    lead_persona_id: "builtin:fizz",
  });
  const relayPubkey = sign(relayKey, 1, [], {}).pubkey;
  const account = {
    ownerPubkey: owner.pubkey,
    channelId: "channel",
    rootEventId: "root",
  };
  const action = sign(
    ownerKey,
    40013,
    [
      ["p", relayPubkey],
      ["a", `30181:${relayPubkey}:slot`],
      ["company-action", "1", "attach", "request", "idem"],
    ],
    {
      operation: "attach",
      payload: {
        kind: "threadAttach",
        record: {
          channelId: account.channelId,
          threadRoot: account.rootEventId,
        },
      },
    },
  );
  const receiptTags = [
    ["p", owner.pubkey],
    ["a", `30181:${relayPubkey}:slot`],
    ["e", action.id, "", "company-action"],
    ["company-receipt", "1", "request", "idem", "conflict"],
  ];
  const receipt = sign(relayKey, 40014, receiptTags, {
    schema: "colony.company-receipt/v1",
    headEventId: null,
  });
  const input = {
    account,
    relayPubkey,
    actions: [action],
    receipts: [receipt],
    teams: [owner],
  };
  const result = taskFailureEvidence(input);
  assert.equal(result.taskRequests[0].receipts[0].id, receipt.id);
  assert.equal(result.ownerTeamHeads[0].id, owner.id);
  assert.equal(
    Reflect.ownKeys(result.taskRequests[0].action).length,
    7,
    "No cached verification metadata or extra fields exported",
  );
  assert.equal(
    taskFailureEvidence({
      ...input,
      account: { ...account, rootEventId: "other" },
    }).taskRequests.length,
    0,
  );
  for (const badReceipt of [
    { ...receipt, content: '{"schema":"tampered"}' },
    sign(ownerKey, 40014, receiptTags, {
      schema: "colony.company-receipt/v1",
      headEventId: null,
    }),
    sign(
      relayKey,
      40014,
      receiptTags.map((tag) =>
        tag[0] === "company-receipt"
          ? ["company-receipt", "1", "another-request", "idem", "conflict"]
          : tag,
      ),
      { schema: "colony.company-receipt/v1", headEventId: null },
    ),
  ])
    assert.throws(() =>
      taskFailureEvidence({ ...input, receipts: [badReceipt] }),
    );
});

test("failure log projection excludes unrelated records and strips sensitive text", () => {
  const ownerPubkey = "a".repeat(64);
  const fields = {
    message: "HTTP bridge request",
    route: "/events",
    pubkey: ownerPubkey,
    status: 400,
    accepted: false,
    kind: 40013,
    reason: "this company has no coordination team to own ambiguous work",
  };
  const lines = [
    "incomplete JSON tail",
    "null",
    JSON.stringify({
      ...fields,
      password: "never-export-this",
      headers: { Authorization: "never-export-this" },
    }),
    JSON.stringify({
      fields: {
        ...fields,
        reason: `URL https://private.invalid/path token=never-export-this nsec1abc123 ${"f".repeat(64)}`,
      },
    }),
    JSON.stringify({ ...fields, status: 200 }),
    JSON.stringify({ ...fields, pubkey: "b".repeat(64) }),
    JSON.stringify({ ...fields, kind: 0 }),
    JSON.stringify({ ...fields, route: "/account" }),
  ];
  const output = projectIngestFailures(lines, ownerPubkey);
  assert.equal(output.length, 2);
  assert.equal(output[0].reason, fields.reason);
  assert.doesNotMatch(
    JSON.stringify(output),
    /never-export-this|private\.invalid|nsec1|ffff/,
  );
  const control = projectIngestFailures(
    [
      JSON.stringify({
        ...fields,
        reason: `reason${String.fromCharCode(0, 31, 127)}end`,
      }),
    ],
    ownerPubkey,
  )[0].reason;
  assert.equal(control, "reason end");
  assert.equal(
    projectIngestFailures(Array(30).fill(JSON.stringify(fields)), ownerPubkey)
      .length,
    20,
  );
  assert.equal(
    projectIngestFailures(
      [JSON.stringify({ ...fields, reason: "x".repeat(1000) })],
      ownerPubkey,
    )[0].reason.length,
    500,
  );
});

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
  const action = {
    requestId: "2e81fba5-6f00-4786-a991-c1a12198fdbe",
    preparation: {
      ownerPubkey: common.ownerPubkey,
      communityRelayUrl:
        "wss://horizon-labs.onboarding-01e484b5c1c936a5.invalid",
    },
    definition: { systemPrompt: "Write." },
  };
  const worker = {
    id: "cae2d97d-957b-5269-b9fb-63018ad0902d",
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
    action,
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

test("worker definition coordinate matches the observed real native owner/community-scoped UUID", () => {
  // Observed native result in GitHub proof34418895093, not a locally generated expected value.
  const action = {
    requestId: "2e81fba5-6f00-4786-a991-c1a12198fdbe",
    preparation: {
      ownerPubkey:
        "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
      communityRelayUrl:
        "wss://horizon-labs.onboarding-01e484b5c1c936a5.invalid",
    },
  };
  assert.equal(
    scopedFirstJobDefinitionId(action),
    "cae2d97d-957b-5269-b9fb-63018ad0902d",
  );
  for (const preparation of [
    { ...action.preparation, ownerPubkey: "b".repeat(64) },
    {
      ...action.preparation,
      communityRelayUrl:
        "wss://horizon-labs.onboarding-1111111111111111.invalid",
    },
  ])
    assert.notEqual(
      scopedFirstJobDefinitionId({ ...action, preparation }),
      scopedFirstJobDefinitionId(action),
    );
  assert.throws(() =>
    scopedFirstJobDefinitionId({
      ...action,
      preparation: {
        ...action.preparation,
        communityRelayUrl: "wss://example.com",
      },
    }),
  );
});

test("worker coordinate refuses noncanonical whitespace and root slash", () => {
  const action = {
    requestId: "2e81fba5-6f00-4786-a991-c1a12198fdbe",
    preparation: {
      ownerPubkey: "a".repeat(64),
      communityRelayUrl:
        "wss://horizon-labs.onboarding-01e484b5c1c936a5.invalid",
    },
  };
  for (const suffix of ["\n", "/"])
    assert.throws(() =>
      scopedFirstJobDefinitionId({
        ...action,
        preparation: {
          ...action.preparation,
          communityRelayUrl: action.preparation.communityRelayUrl + suffix,
        },
      }),
    );
  assert.throws(() =>
    scopedFirstJobDefinitionId({
      ...action,
      requestId: action.requestId + "\n",
    }),
  );
  assert.throws(() =>
    scopedFirstJobDefinitionId({
      ...action,
      preparation: {
        ...action.preparation,
        ownerPubkey: action.preparation.ownerPubkey + "\n",
      },
    }),
  );
});

test("an early rejected provider request still counts as a received call", async () => {
  const provider = await createOnboardingFixtureProvider();
  try {
    const response = await fetch(`${provider.httpUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer synthetic-onboarding-provider",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 500);
    await response.json();
    assert.equal(provider.receivedCallCount, 1);
    assert.equal(provider.requests.length, 0);
    assert.throws(
      () => provider.assertHealthy(),
      /No model calls are allowed before explicit staffing/,
    );
  } finally {
    await provider.close();
  }
});

test("preview observation waits beyond five seconds without issuing a query retry", async () => {
  let elapsed = 0;
  let evidence;
  await waitForTeamPreview({
    now: () => elapsed,
    delay: async (ms) => {
      elapsed += ms;
    },
    readState: async () => ({
      pending: elapsed < 10_000,
      ready: elapsed >= 10_000,
    }),
    onObservation: (value) => {
      evidence = value;
    },
  });
  assert.deepEqual(evidence, {
    status: "ready",
    error: null,
    elapsedMs: 10_000,
  });
});

test("preview observation fails immediately on a real error or unavailable proposal", async () => {
  for (const state of [
    { error: "Native request failed token=never-export-this" },
    { retryAvailable: true },
  ]) {
    let reads = 0;
    let evidence;
    await assert.rejects(
      waitForTeamPreview({
        now: () => 0,
        delay: async () => assert.fail("Terminal errors must not be retried"),
        readState: async () => {
          reads += 1;
          return state;
        },
        onObservation: (value) => {
          evidence = value;
        },
      }),
      /Team preview (failed|finished)/,
    );
    assert.equal(reads, 1);
    assert.doesNotMatch(JSON.stringify(evidence), /never-export-this/);
    assert.equal(evidence.elapsedMs, 0);
  }
});

test("preview observation times out truthfully with the last rendered pending state", async () => {
  let elapsed = 0;
  let evidence;
  await assert.rejects(
    waitForTeamPreview({
      now: () => elapsed,
      delay: async (ms) => {
        elapsed += ms;
      },
      readState: async () => ({ pending: true }),
      onObservation: (value) => {
        evidence = value;
      },
    }),
    /did not settle within 75s \(pending\)/,
  );
  assert.deepEqual(evidence, {
    status: "pending",
    error: null,
    elapsedMs: 75_000,
  });
});
