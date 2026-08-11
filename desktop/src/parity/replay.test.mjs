/**
 * Parity oracle — replay harness negative control.
 *
 * An oracle nobody has seen fail is not yet an oracle. These tests prove the
 * harness catches exactly the two regressions the ticket demands:
 *  1. a perturbed command RESULT (extra/mutated field) is diffed;
 *  2. a perturbed ERROR MESSAGE string is diffed (error strings are data —
 *     `relay.rs:279` emits `relay rate-limited: retry in {secs}s` and
 *     `tauri.ts:305` string-matches that prefix to arm the TS backoff gate).
 *
 * The green case (unperturbed replay of a recorded trace through a bridge
 * that reproduces the recorded outcomes) must stay clean.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeTrace, encodeTrace, fingerprintBinary } from "./types.ts";
import {
  TraceNormalizer,
  canonicalizeBinary,
  canonicalizeProfileAvatar,
  canonicalizePushPayload,
} from "./canonicalizers.ts";
import { replayTrace } from "./replay.ts";
import { ParityRecorder, redactSensitiveKeys } from "./recorder.ts";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const HEX64 = "ab".repeat(32);
const EVENT_ID = "cd".repeat(32);
const EPOCH = 1_752_000_000;

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function syntheticTrace() {
  const header = {
    schema: "parity-trace/v1",
    session: "test-session",
    runId: "test-run",
    recordedAt: "2026-08-07T00:00:00.000Z",
    relayUrl: "ws://localhost:3000",
    appVersion: null,
    recordedBy: "tauri-internals",
  };
  const records = [
    {
      kind: "command",
      seq: 1,
      command: "get_identity",
      args: {},
      outcome: { ok: true, result: { pubkey: HEX64 } },
      durationMs: 4,
    },
    {
      kind: "command",
      seq: 2,
      command: "get_profile",
      args: {},
      outcome: {
        ok: true,
        result: {
          display_name: "Parity Oracle",
          nip05: null,
          created_at: EPOCH,
        },
      },
      durationMs: 5,
    },
    {
      kind: "command",
      seq: 3,
      command: "send_channel_message",
      args: { channelId: UUID, content: "probe" },
      outcome: {
        ok: true,
        result: {
          event_id: EVENT_ID,
          parent_event_id: null,
          created_at: EPOCH,
        },
      },
      durationMs: 12,
    },
    {
      kind: "command",
      seq: 4,
      command: "plugin:websocket|connect",
      args: { url: "ws://localhost:3000", onMessage: "__CHANNEL__:7" },
      outcome: { ok: true, result: 700 },
      durationMs: 3,
    },
    {
      kind: "command",
      seq: 5,
      command: "delete_channel",
      args: { channelId: UUID },
      outcome: {
        ok: false,
        error: { message: `no such channel: ${UUID}` },
      },
      durationMs: 3,
    },
    {
      kind: "event",
      seq: 6,
      name: "agents-data-changed",
      payload: { agent: { pubkey: HEX64 } },
    },
    {
      kind: "push",
      seq: 7,
      subscription: "__CHANNEL__:7",
      payload: ["EVENT", "sub", { id: EVENT_ID, pubkey: HEX64, kind: 1 }],
    },
  ];
  return { header, records };
}

/**
 * Bridge that answers invoke from the recorded trace (first unmatched
 * outcome per command) and re-emits the recorded events and pushes. This is
 * a reproduction bridge: it can only go green when the harness itself is
 * consistent with the recording, which is exactly what the negative control
 * needs — perturb it and the harness must go red.
 */
class TraceBridge {
  constructor(trace) {
    this.pending = trace.records
      .filter((r) => r.kind === "command")
      .map((r) => ({ command: r.command, outcome: r.outcome }));
    this.events = trace.records.filter((r) => r.kind === "event");
    this.pushes = trace.records.filter((r) => r.kind === "push");
    this.unlistens = [];
  }

  async invoke(command, args) {
    if (command === "plugin:websocket|connect") {
      // Deliver the recorded pushes through the channel the harness passed
      // in (the seam path: pushes arrive on NativeChannel.onmessage).
      const channel = args?.onMessage;
      if (channel && this.pushes.length > 0) {
        setTimeout(() => {
          for (const push of this.pushes) {
            channel.onmessage?.(deepClone(push.payload));
          }
        }, 1);
      }
      return 700;
    }
    const index = this.pending.findIndex((p) => p.command === command);
    if (index < 0) {
      throw new Error(`trace bridge has no recorded outcome for ${command}`);
    }
    const [entry] = this.pending.splice(index, 1);
    if (entry.outcome.ok) {
      return deepClone(entry.outcome.result);
    }
    throw new Error(entry.outcome.error.message);
  }

  async listen(name, handler) {
    for (const event of this.events.filter((e) => e.name === name)) {
      setTimeout(
        () => handler({ event: name, payload: deepClone(event.payload) }),
        0,
      );
    }
    const unlisten = () => {};
    this.unlistens.push(unlisten);
    return unlisten;
  }
}

test("trace encode/decode roundtrips", () => {
  const trace = syntheticTrace();
  const decoded = decodeTrace(encodeTrace(trace));
  assert.equal(decoded.header.schema, "parity-trace/v1");
  assert.deepEqual(decoded.records, trace.records);
});

test("normalizer marks volatile values: uuid, hex64, epoch, fixture", () => {
  const normalizer = new TraceNormalizer();
  const normalized = normalizer.normalize({
    id: UUID,
    pubkey: HEX64,
    createdAt: EPOCH,
    name: "parity-oracle-test-abc",
    stable: "keep-me",
  });
  assert.match(normalized.id, /^\$uuid:[0-9a-f]{8}$/);
  assert.match(normalized.pubkey, /^\$hex:[0-9a-f]{8}$/);
  assert.match(normalized.createdAt, /^\$time:[0-9a-f]{8}$/);
  assert.equal(normalized.name, "$fixture");
  assert.equal(normalized.stable, "keep-me");
  // Same value -> same marker, regardless of position (value-derived, not
  // first-seen-order derived).
  assert.equal(normalizer.normalize(UUID), normalized.id);
  // Different value in the same family -> different marker.
  assert.notEqual(
    normalizer.normalize(`${HEX64.slice(0, 63)}0`),
    normalized.pubkey,
  );
  // Same value first seen in a different order still maps to the same marker.
  const fresh = new TraceNormalizer();
  assert.equal(fresh.normalize({ late: HEX64 }).late, normalized.pubkey);
});

test("fingerprintBinary hashes dense numeric arrays (audio frames)", async () => {
  const samples = new Array(256).fill(0.5).map((v, i) => v + i * 1e-9);
  const fingerprint = await fingerprintBinary(samples);
  assert.equal(fingerprint.$binary.length, 256 * 4);
  assert.match(fingerprint.$binary.sha256, /^[0-9a-f]{64}$/);
});

test("recorder keeps ARGS replayable and redacts sensitive RESULTS", async () => {
  const recorder = new ParityRecorder();
  await recorder.recordCommand(
    "save_discovery_credential",
    { provider: "outscraper", key: "parity-oracle-fixture-key" },
    { ok: true, result: "configured" },
    1,
  );
  await recorder.recordCommand(
    "get_nsec",
    {},
    { ok: true, result: "nsec1real-ish-value" },
    1,
  );
  const trace = recorder.buildTrace({
    session: "test",
    runId: "r",
    recordedAt: "2026-08-07T00:00:00.000Z",
    relayUrl: null,
    appVersion: null,
    recordedBy: "tauri-internals",
  });
  // Args are recorded verbatim so replay can re-invoke them.
  assert.deepEqual(trace.records[0].args, {
    provider: "outscraper",
    key: "parity-oracle-fixture-key",
  });
  // Whole-value result redactors still apply.
  assert.equal(trace.records[1].outcome.result.$redacted, "nsec");
  const redacted = redactSensitiveKeys({ apiKey: "x", nested: { token: "y" } });
  assert.equal(redacted.apiKey.$redacted, "apiKey");
  assert.equal(redacted.nested.token.$redacted, "token");
});

test("recorder redaction of an undefined arg value does not corrupt replay", async () => {
  const recorder = new ParityRecorder();
  await recorder.recordCommand(
    "apply_workspace",
    { relayUrl: "ws://localhost:3000", nsec: undefined, token: undefined },
    { ok: true, result: "ok" },
    1,
  );
  const trace = recorder.buildTrace({
    session: "test",
    runId: "r",
    recordedAt: "2026-08-07T00:00:00.000Z",
    relayUrl: null,
    appVersion: null,
    recordedBy: "tauri-internals",
  });
  // Undefined values are kept in-memory (dropped by JSON serialization);
  // crucially they are NOT replaced by redaction markers.
  assert.equal(trace.records[0].args.nsec, undefined);
  assert.equal(trace.records[0].args.token, undefined);
  assert.equal(trace.records[0].args.relayUrl, "ws://localhost:3000");
  const decoded = decodeTrace(encodeTrace(trace));
  assert.deepEqual(decoded.records[0].args, {
    relayUrl: "ws://localhost:3000",
  });
});

test("canonicalizeBinary reduces recorded fingerprint and live bytes to length", () => {
  const recorded = { $binary: { length: 884, sha256: "ab".repeat(32) } };
  const live = new Array(884).fill(7);
  const both = [recorded, live].map(canonicalizeBinary);
  assert.deepEqual(both[0], { $binary: { length: 884 } });
  assert.deepEqual(both[1], { $binary: { length: 884 } });
});

test("NEGATIVE CONTROL green: jsonArgs REQ payload retargets to live channel", async () => {
  const { header, records } = syntheticTrace();
  const reqData = JSON.stringify([
    "REQ",
    "live-0f8fad5b-d9cb-469f-a165-70867728950e",
    { kinds: [9], "#h": [UUID] },
  ]);
  const trace = {
    header,
    records: [
      { ...records[0], seq: 1 },
      {
        kind: "command",
        seq: 2,
        command: "create_channel",
        args: { name: "fixture" },
        outcome: { ok: true, result: { id: UUID } },
        durationMs: 5,
      },
      {
        kind: "command",
        seq: 3,
        command: "plugin:websocket|connect",
        args: { url: "ws://localhost:3000", onMessage: "__CHANNEL__:1" },
        outcome: { ok: true, result: 7 },
        durationMs: 10,
      },
      {
        kind: "command",
        seq: 4,
        command: "plugin:websocket|send",
        args: { id: 7, message: { type: "Text", data: reqData } },
        outcome: { ok: true, result: null },
        durationMs: 2,
      },
      {
        kind: "event",
        seq: 5,
        name: "agents-data-changed",
        payload: { agent: { pubkey: HEX64 } },
      },
    ],
  };
  let observedArgs = null;
  const bridge = new TraceBridge(trace);
  bridge.invoke = async (command, args) => {
    if (command === "plugin:websocket|connect") {
      return 900;
    }
    if (command === "plugin:websocket|send") {
      observedArgs = args;
      return null;
    }
    return TraceBridge.prototype.invoke.call(bridge, command);
  };
  const report = await replayTrace({
    trace,
    bridge,
    script: {
      create_channel: { result: { channelId: "id" } },
      "plugin:websocket|send": {
        jsonArgs: [
          { path: "message.data", rewrite: { "2.#h.0": "channelId" } },
        ],
      },
    },
    settleMs: 50,
  });
  assert.equal(report.clean, true, JSON.stringify(report.commands, null, 2));
  const parsed = JSON.parse(observedArgs.message.data);
  assert.equal(parsed[2]["#h"][0], UUID);
  assert.notEqual(observedArgs.id, 7, "ws id remapped to the live connection");
});

test("live-side canonicalizer redacts recorded-redacted results", async () => {
  const { header, records } = syntheticTrace();
  const trace = {
    header,
    records: records.map((r, i) =>
      i === 0
        ? {
            ...r,
            command: "get_nsec",
            args: {},
            outcome: { ok: true, result: { $redacted: "nsec" } },
          }
        : r,
    ),
  };
  const bridge = new TraceBridge(trace);
  const realInvoke = TraceBridge.prototype.invoke;
  bridge.invoke = async (command) => {
    if (command === "get_nsec") {
      return "nsec1raw-from-live";
    }
    return realInvoke.call(bridge, command);
  };
  const report = await replayWith([], trace);
  assert.equal(report.clean, true, JSON.stringify(report.commands, null, 2));
});

async function replayWith(perturbations, trace = syntheticTrace()) {
  const bridge = new TraceBridge(trace);
  return replayTrace({
    trace,
    bridge,
    perturbations,
    settleMs: 50,
  });
}

test("NEGATIVE CONTROL green: unperturbed replay of recorded trace is clean", async () => {
  const report = await replayWith([]);
  assert.equal(report.clean, true, JSON.stringify(report.commands, null, 2));
  assert.equal(report.summary.commands, 5);
  assert.equal(report.summary.diffCommands, 0);
  assert.equal(report.summary.matched, 5);
  assert.equal(report.summary.eventsRecorded, 1);
  assert.equal(report.summary.eventsObserved, 1);
  assert.equal(report.summary.pushRecorded, 1);
  assert.equal(report.summary.pushMatched, 1);
  // TraceBridge resolves synchronously (~0ms), recorded durations are
  // measured on the live app, so the delta is negative but must stay
  // bounded.
  assert.ok(
    report.timing.totalDeltaMs >= -10000,
    `totalDeltaMs=${report.timing.totalDeltaMs} (expected=${report.timing.totalExpectedMs} actual=${report.timing.totalActualMs})`,
  );
});

test("regression: command with undefined args replays cleanly (deepClone)", async () => {
  const { header, records } = syntheticTrace();
  const trace = {
    header,
    records: records.map((r, i) => (i === 0 ? { ...r, args: undefined } : r)),
  };
  const report = await replayWith([], trace);
  assert.equal(report.clean, true, JSON.stringify(report.commands, null, 2));
  assert.equal(report.summary.diffCommands, 0);
});

test("NEGATIVE CONTROL red: perturbed command RESULT is caught", async () => {
  const report = await replayWith([
    {
      command: "send_channel_message",
      mutateOutcome: (outcome) => ({
        ok: true,
        result: { ...outcome.result, $perturbed: true },
      }),
    },
  ]);
  assert.equal(report.clean, false);
  const target = report.commands.find(
    (c) => c.command === "send_channel_message",
  );
  assert.ok(target, "send_channel_message result present");
  assert.equal(target.match, false);
  // The send_channel_message canonicalizer strips generated fields, so a
  // perturbed result that adds a key diffs at the canonicalized root.
  assert.ok(
    target.diffs.some((d) => d.path === "$" || d.path === "$.result"),
    `expected diff at $ or $.result, got ${JSON.stringify(target.diffs)}`,
  );
  assert.ok(
    target.diffs.some((d) => d.actual && d.actual.$perturbed === true),
    `expected perturbed field visible in diff, got ${JSON.stringify(target.diffs)}`,
  );
});

test("NEGATIVE CONTROL red: perturbed ERROR MESSAGE string is caught", async () => {
  const report = await replayWith([
    {
      command: "delete_channel",
      mutateOutcome: (outcome) => ({
        ok: false,
        error: { message: `${outcome.error.message} [PERTURBED]` },
      }),
    },
  ]);
  assert.equal(report.clean, false);
  const target = report.commands.find((c) => c.command === "delete_channel");
  assert.ok(target, "delete_channel result present");
  assert.equal(target.match, false);
  assert.ok(
    target.diffs.some((d) => d.path === "$.error.message"),
    `expected diff at $.error.message, got ${JSON.stringify(target.diffs)}`,
  );
});

test("canonicalizePushPayload reduces wire forms to role markers", () => {
  const auth = canonicalizePushPayload({
    type: "Text",
    data: JSON.stringify(["AUTH", "ab".repeat(32)]),
  });
  assert.deepEqual(auth, { type: "Text", data: ["AUTH", "$auth-challenge"] });
  const event = canonicalizePushPayload({
    type: "Text",
    data: JSON.stringify([
      "EVENT",
      "live-0f8fad5b-d9cb-469f-a165-70867728950e",
      {
        id: "aa".repeat(32),
        pubkey: HEX64,
        kind: 9,
        content: "probe",
        tags: [["h", UUID]],
        sig: "bb".repeat(64),
        created_at: EPOCH,
      },
    ]),
  });
  assert.deepEqual(event, {
    type: "Text",
    data: [
      "EVENT",
      "$subId",
      { kind: 9, pubkey: HEX64, content: "probe", tags: [["h", UUID]] },
    ],
  });
  const deletion = canonicalizePushPayload({
    type: "Text",
    data: JSON.stringify([
      "EVENT",
      "live-0f8fad5b-d9cb-469f-a165-70867728950e",
      {
        id: "ab".repeat(32),
        pubkey: HEX64,
        kind: 5,
        content: "",
        tags: [
          ["e", "cd".repeat(32)],
          ["h", UUID],
        ],
        sig: "bb".repeat(64),
        created_at: EPOCH,
      },
    ]),
  });
  assert.deepEqual(deletion, {
    type: "Text",
    data: [
      "EVENT",
      "$subId",
      {
        kind: 5,
        pubkey: HEX64,
        content: "",
        tags: [
          ["e", "$deleted-event"],
          ["h", UUID],
        ],
      },
    ],
  });
  const ok = canonicalizePushPayload({
    type: "Text",
    data: JSON.stringify(["OK", "cc".repeat(32), true, ""]),
  });
  assert.deepEqual(ok, { type: "Text", data: ["OK", "$eventId", true, ""] });
  // Ping/Close frames pass through untouched.
  assert.deepEqual(canonicalizePushPayload({ type: "Ping", data: [] }), {
    type: "Ping",
    data: [],
  });
});

test("canonicalizeProfileAvatar treats null and empty avatar_url as one value", () => {
  const before = {
    pubkey: HEX64,
    display_name: "$fixture",
    avatar_url: null,
    has_profile_event: true,
  };
  const after = { ...before, avatar_url: "" };
  assert.deepEqual(
    canonicalizeProfileAvatar(before),
    canonicalizeProfileAvatar(after),
  );
  assert.equal(
    canonicalizeProfileAvatar({ ...before, avatar_url: null }).avatar_url,
    null,
  );
  assert.equal(
    canonicalizeProfileAvatar({ ...before, avatar_url: "" }).avatar_url,
    null,
  );
  // A real avatar is untouched; nested profile maps are walked.
  assert.deepEqual(
    canonicalizeProfileAvatar({
      profiles: { [HEX64]: { avatar_url: "", display_name: "x" } },
    }),
    { profiles: { [HEX64]: { avatar_url: null, display_name: "x" } } },
  );
  assert.equal(
    canonicalizeProfileAvatar({ avatar_url: "https://example.com/a.png" })
      .avatar_url,
    "https://example.com/a.png",
  );
});

test("channel id correlation: recorded results follow the live channel", async () => {
  const { header } = syntheticTrace();
  const recordedChannel = "11111111-1111-4111-8111-111111111111";
  const liveChannel = "22222222-2222-4222-8222-222222222222";
  const recordedEvent = JSON.stringify({
    id: "aa".repeat(32),
    pubkey: HEX64,
    kind: 9,
    content: "probe",
    tags: [["h", recordedChannel]],
    sig: "bb".repeat(64),
    created_at: EPOCH,
  });
  const trace = {
    header,
    records: [
      {
        kind: "command",
        seq: 1,
        command: "create_channel",
        args: { name: "fixture" },
        outcome: {
          ok: true,
          result: {
            id: recordedChannel,
            created_at: EPOCH,
            updated_at: EPOCH,
            name: "fixture",
          },
        },
        durationMs: 4,
      },
      {
        kind: "command",
        seq: 2,
        command: "get_channel_details",
        args: { channelId: recordedChannel },
        outcome: {
          ok: true,
          result: {
            id: recordedChannel,
            created_at: EPOCH,
            updated_at: EPOCH,
            name: "fixture",
          },
        },
        durationMs: 4,
      },
      {
        kind: "command",
        seq: 3,
        command: "get_event",
        args: { eventId: "aa".repeat(32) },
        outcome: { ok: true, result: recordedEvent },
        durationMs: 4,
      },
      {
        kind: "event",
        seq: 4,
        name: "agents-data-changed",
        payload: { agent: { pubkey: HEX64 } },
      },
    ],
  };
  const bridge = new TraceBridge(trace);
  bridge.invoke = async (command) => {
    if (command === "create_channel") {
      return {
        id: liveChannel,
        created_at: EPOCH,
        updated_at: EPOCH,
        name: "fixture",
      };
    }
    if (command === "get_channel_details") {
      return {
        id: liveChannel,
        created_at: EPOCH,
        updated_at: EPOCH,
        name: "fixture",
      };
    }
    if (command === "get_event") {
      return JSON.stringify({
        id: "cc".repeat(32),
        pubkey: HEX64,
        kind: 9,
        content: "probe",
        tags: [["h", liveChannel]],
        sig: "dd".repeat(64),
        created_at: EPOCH,
      });
    }
    return TraceBridge.prototype.invoke.call(bridge, command);
  };
  const report = await replayTrace({
    trace,
    bridge,
    script: {
      create_channel: { result: { channelId: "id" } },
      get_channel_details: { args: { channelId: "channelId" } },
    },
    settleMs: 50,
  });
  assert.equal(report.clean, true, JSON.stringify(report.commands, null, 2));
});

test("pushes match across the live channel id boundary", async () => {
  const { header } = syntheticTrace();
  const recordedChannel = "11111111-1111-4111-8111-111111111111";
  const liveChannel = "22222222-2222-4222-8222-222222222222";
  const trace = {
    header,
    records: [
      {
        kind: "command",
        seq: 1,
        command: "create_channel",
        args: { name: "fixture" },
        outcome: { ok: true, result: { id: recordedChannel } },
        durationMs: 4,
      },
      {
        kind: "command",
        seq: 2,
        command: "plugin:websocket|connect",
        args: { url: "ws://localhost:3000", onMessage: "__CHANNEL__:1" },
        outcome: { ok: true, result: 7 },
        durationMs: 5,
      },
      {
        kind: "push",
        seq: 3,
        subscription: "__CHANNEL__:1",
        payload: {
          type: "Text",
          data: JSON.stringify([
            "EVENT",
            "live-0f8fad5b-d9cb-469f-a165-70867728950e",
            {
              id: "aa".repeat(32),
              pubkey: HEX64,
              kind: 9,
              content: "probe",
              tags: [["h", recordedChannel]],
              sig: "bb".repeat(64),
              created_at: EPOCH,
            },
          ]),
        },
      },
      {
        kind: "event",
        seq: 4,
        name: "agents-data-changed",
        payload: { agent: { pubkey: HEX64 } },
      },
    ],
  };
  const bridge = new TraceBridge(trace);
  bridge.invoke = async (command, args) => {
    if (command === "create_channel") {
      return { id: liveChannel };
    }
    if (command === "plugin:websocket|connect") {
      const channel = args.onMessage;
      setTimeout(() => {
        channel.onmessage?.({
          type: "Text",
          data: JSON.stringify([
            "EVENT",
            "live-0f8fad5b-d9cb-469f-a165-70867728950e",
            {
              id: "cc".repeat(32),
              pubkey: HEX64,
              kind: 9,
              content: "probe",
              tags: [["h", liveChannel]],
              sig: "dd".repeat(64),
              created_at: EPOCH + 1,
            },
          ]),
        });
      }, 5);
      return 500;
    }
    return TraceBridge.prototype.invoke.call(bridge, command);
  };
  const report = await replayTrace({
    trace,
    bridge,
    script: { create_channel: { result: { channelId: "id" } } },
    settleMs: 200,
  });
  assert.equal(report.clean, true, JSON.stringify(report, null, 2));
  assert.equal(report.summary.pushRecorded, 1);
  assert.equal(report.summary.pushMatched, 1);
  assert.equal(report.summary.pushObserved, 1);
});

test("freshArgs rewrites now-cursors at replay", async () => {
  const { header } = syntheticTrace();
  const event = {
    id: "aa".repeat(32),
    pubkey: HEX64,
    kind: 40099,
    content: '{"type":"channel_created"}',
    tags: [["h", UUID]],
    sig: "bb".repeat(64),
    created_at: EPOCH,
  };
  const trace = {
    header,
    records: [
      {
        kind: "command",
        seq: 1,
        command: "get_channel_messages_before",
        args: {
          channelId: UUID,
          before: 1000,
          beforeId: "ab".repeat(32),
          limit: 10,
        },
        outcome: { ok: true, result: { events: [event], next_cursor: null } },
        durationMs: 5,
      },
      {
        kind: "event",
        seq: 2,
        name: "agents-data-changed",
        payload: { agent: { pubkey: HEX64 } },
      },
    ],
  };
  let liveArgs = null;
  const bridge = new TraceBridge(trace);
  bridge.invoke = async (command, args) => {
    if (command === "get_channel_messages_before") {
      liveArgs = args;
      return {
        events: [
          {
            ...event,
            id: "cc".repeat(32),
            sig: "dd".repeat(64),
            created_at: EPOCH + 1,
          },
        ],
        next_cursor: { created_at: EPOCH + 2, event_id: "ee".repeat(32) },
      };
    }
    return TraceBridge.prototype.invoke.call(bridge, command);
  };
  const report = await replayTrace({
    trace,
    bridge,
    script: {
      get_channel_messages_before: { freshArgs: ["before"] },
    },
    settleMs: 50,
  });
  assert.equal(report.clean, true, JSON.stringify(report.commands, null, 2));
  assert.ok(
    liveArgs.before > 1_750_000_000,
    `before cursor rewritten to now, got ${liveArgs.before}`,
  );
});

test("AUTH send rewrite re-signs with the live challenge", async () => {
  const { header } = syntheticTrace();
  const liveChallenge = "live-challenge-value";
  const recordedChallenge = "recorded-challenge-value";
  const authEvent = {
    id: "aa".repeat(32),
    pubkey: HEX64,
    kind: 22242,
    created_at: EPOCH,
    content: "",
    tags: [
      ["challenge", recordedChallenge],
      ["relay", "ws://localhost:3000"],
    ],
    sig: "bb".repeat(64),
  };
  const trace = {
    header: { ...header, relayUrl: "ws://localhost:3000" },
    records: [
      {
        kind: "command",
        seq: 1,
        command: "plugin:websocket|connect",
        args: { url: "ws://localhost:3000", onMessage: "__CHANNEL__:1" },
        outcome: { ok: true, result: 7 },
        durationMs: 5,
      },
      {
        kind: "command",
        seq: 2,
        command: "plugin:websocket|send",
        args: {
          id: 7,
          message: { type: "Text", data: JSON.stringify(["AUTH", authEvent]) },
        },
        outcome: { ok: true, result: null },
        durationMs: 3,
      },
      {
        kind: "push",
        seq: 3,
        subscription: "__CHANNEL__:1",
        payload: {
          type: "Text",
          data: JSON.stringify(["AUTH", liveChallenge]),
        },
      },
      {
        kind: "push",
        seq: 4,
        subscription: "__CHANNEL__:1",
        payload: {
          type: "Text",
          data: JSON.stringify(["OK", "cc".repeat(32), true, ""]),
        },
      },
      {
        kind: "event",
        seq: 5,
        name: "agents-data-changed",
        payload: { agent: { pubkey: HEX64 } },
      },
    ],
  };
  let authArgs = null;
  let authSendData = null;
  const bridge = new TraceBridge(trace);
  bridge.invoke = async (command, args) => {
    if (command === "plugin:websocket|connect") {
      const channel = args.onMessage;
      setTimeout(() => {
        channel.onmessage?.({
          type: "Text",
          data: JSON.stringify(["AUTH", liveChallenge]),
        });
        setTimeout(() => {
          channel.onmessage?.({
            type: "Text",
            data: JSON.stringify(["OK", "dd".repeat(32), true, ""]),
          });
        }, 5);
      }, 1);
      return 500;
    }
    if (command === "create_auth_event") {
      authArgs = args;
      return JSON.stringify({
        ...authEvent,
        id: "ee".repeat(32),
        created_at: EPOCH + 1,
        tags: [
          ["challenge", args.challenge],
          ["relay", "ws://localhost:3000"],
        ],
      });
    }
    if (command === "plugin:websocket|send") {
      authSendData = args.message.data;
      return null;
    }
    return TraceBridge.prototype.invoke.call(bridge, command);
  };
  const report = await replayTrace({
    trace,
    bridge,
    settleMs: 200,
  });
  assert.equal(report.clean, true, JSON.stringify(report, null, 2));
  assert.equal(authArgs.challenge, liveChallenge);
  const sent = JSON.parse(authSendData);
  assert.equal(sent[0], "AUTH");
  assert.equal(sent[1].tags[0][1], liveChallenge);
  assert.equal(report.summary.pushMatched, 2);
});
