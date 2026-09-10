import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  captureBlocksManifestQueryState,
  installBlocksManifestDiagnostics,
} from "../tests/helpers/blocksLiveDiagnostics.ts";

const MANIFEST = "a".repeat(64);
const OTHER_MANIFEST = "b".repeat(64);
const RELAY_SELF = "c".repeat(64);
const SECRET = "must-never-appear-in-diagnostics";
const RELAY_URL = "ws://127.0.0.1:39001";

class Socket extends EventEmitter {
  url() {
    return `${RELAY_URL}/`;
  }
  send(frame) {
    this.emit("framesent", { payload: JSON.stringify(frame) });
  }
  receive(frame) {
    this.emit("framereceived", { payload: JSON.stringify(frame) });
  }
}

function setup() {
  const page = new EventEmitter();
  const diagnostics = installBlocksManifestDiagnostics(page, RELAY_URL, {
    manifestIds: [MANIFEST],
    relaySelfPubkey: RELAY_SELF,
  });
  const socket = new Socket();
  page.emit("websocket", socket);
  diagnostics.start();
  return { page, socket, diagnostics };
}

const manifestFilter = { kinds: [40012], ids: [MANIFEST], limit: 1 };

test("manifest diagnostics correlate only fixture requests and omit sensitive payloads", () => {
  const { socket, diagnostics } = setup();
  socket.send(["REQ", SECRET, manifestFilter]);
  socket.receive(["AUTH", SECRET]);
  socket.receive(["NOTICE", `rate-limited: ${SECRET}`]);
  socket.receive([
    "EVENT",
    SECRET,
    {
      id: MANIFEST,
      kind: 40012,
      pubkey: RELAY_SELF,
      content: SECRET,
      tags: [["private", SECRET]],
      sig: SECRET,
    },
  ]);
  socket.receive(["EOSE", SECRET]);
  socket.send([
    "REQ",
    "catalog-secret",
    {
      kinds: [30178],
      authors: [RELAY_SELF],
      "#d": ["lead-card"],
    },
  ]);
  socket.receive([
    "CLOSED",
    "catalog-secret",
    `rate-limited: quota exceeded; retry in 2s ${SECRET}`,
  ]);
  socket.send([
    "REQ",
    "roster-secret",
    { kinds: [13534], authors: [RELAY_SELF] },
  ]);
  socket.receive(["CLOSED", "roster-secret", `auth-required: ${SECRET}`]);
  socket.send(["REQ", "unrelated", { kinds: [40012], ids: [OTHER_MANIFEST] }]);
  socket.send([
    "REQ",
    "wrong-author",
    { kinds: [13534], authors: [OTHER_MANIFEST] },
  ]);
  socket.send([
    "REQ",
    "wrong-handle",
    { kinds: [30178], authors: [RELAY_SELF], "#d": [SECRET] },
  ]);
  socket.send(["REQ", "mixed", manifestFilter, { kinds: [0] }]);
  const snapshot = diagnostics.snapshot();
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.type),
    ["REQ", "EVENT", "EOSE", "REQ", "CLOSED", "REQ", "CLOSED"],
  );
  assert.equal(snapshot.entries[1].request, snapshot.entries[0].request);
  assert.equal(snapshot.entries[4].requestCategory, "catalog");
  assert.equal(snapshot.entries[4].category, "rate-limited");
  assert.equal(snapshot.entries[4].retryInSeconds, 2);
  assert.equal(snapshot.entries[6].category, "auth-required");
  assert.equal(snapshot.trackedSubscriptions, 0);
  for (const value of [
    SECRET,
    RELAY_SELF,
    "catalog-secret",
    "roster-secret",
    OTHER_MANIFEST,
  ]) {
    assert.equal(JSON.stringify(snapshot).includes(value), false);
  }
  diagnostics.stop();
});

test("subscription reuse, socket isolation and stop prevent unrelated late metadata", () => {
  const { page, socket, diagnostics } = setup();
  const second = new Socket();
  page.emit("websocket", second);
  socket.send(["REQ", "same", manifestFilter]);
  second.receive(["CLOSED", "same", "rate-limited: quota exceeded"]);
  socket.send(["REQ", "same", { kinds: [0] }]);
  socket.receive(["CLOSED", "same", "rate-limited: quota exceeded"]);
  assert.equal(diagnostics.snapshot().entries.length, 1);
  second.send(["REQ", "second", manifestFilter]);
  second.emit("close");
  assert.equal(second.listenerCount("framesent"), 0);
  const before = diagnostics.snapshot();
  diagnostics.stop();
  diagnostics.stop();
  diagnostics.start();
  assert.equal(page.listenerCount("websocket"), 0);
  assert.equal(socket.listenerCount("framereceived"), 0);
  socket.send(["REQ", "late", manifestFilter]);
  assert.equal(diagnostics.snapshot().entries.length, before.entries.length);
  before.entries[0].type = "mutated";
  assert.equal(diagnostics.snapshot().entries[0].type, "REQ");
});

test("unexpected manifest event IDs are flagged without retaining the unknown ID", () => {
  const { socket, diagnostics } = setup();
  socket.send(["REQ", "manifest", manifestFilter]);
  socket.receive(["EVENT", "manifest", { id: OTHER_MANIFEST, kind: 40012 }]);
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.entries[1].unexpectedEvent, true);
  assert.equal(JSON.stringify(snapshot).includes(OTHER_MANIFEST), false);
  diagnostics.stop();
});

test("UTF-8 frame, entry and tracked-subscription limits remain bounded", () => {
  const { socket, diagnostics } = setup();
  socket.send([
    "REQ",
    "large",
    { ...manifestFilter, ignored: "界".repeat(100_000) },
  ]);
  assert.equal(diagnostics.snapshot().entries.length, 0);
  for (let index = 0; index < 205; index += 1)
    socket.send(["REQ", `request-${index}`, manifestFilter]);
  const full = diagnostics.snapshot();
  assert.equal(full.entries.length, 200);
  assert.equal(full.trackedSubscriptions, 200);
  assert.equal(full.droppedEntries, 5);
  socket.receive(["EOSE", "request-0"]);
  assert.equal(diagnostics.snapshot().trackedSubscriptions, 199);
  diagnostics.stop();
  assert.equal(diagnostics.snapshot().trackedSubscriptions, 0);
});

function query(queryType, manifestId, error, overrides = {}) {
  return {
    queryKey: [queryType, SECRET, manifestId, { sensitive: SECRET }],
    state: {
      status: "error",
      fetchStatus: "idle",
      fetchFailureCount: 2,
      error,
      data: { sensitive: SECRET },
      ...overrides,
    },
  };
}

function queryPage(t, queries) {
  const previous = globalThis.window;
  globalThis.window = {
    __BUZZ_E2E_QUERY_CLIENT__: {
      getQueryCache: () => ({ getAll: () => queries }),
    },
  };
  t.after(() => {
    globalThis.window = previous;
  });
  return { evaluate: async (callback, ids) => callback(ids) };
}

test("query state distinguishes manifest and trust failures without raw cache values", async (t) => {
  const page = queryPage(t, [
    query(
      "block-manifest",
      MANIFEST,
      new Error(
        `Block manifest could not be loaded: Error: rate-limited: ${SECRET}`,
      ),
    ),
    query(
      "block-manifest",
      MANIFEST,
      new Error(
        `Block trust could not be established: Error: Timed out ${SECRET}`,
      ),
    ),
    query("block-data", MANIFEST, null, {
      status: "success",
      fetchFailureCount: 0,
    }),
    query("unrelated", MANIFEST, new Error(SECRET)),
    query("block-manifest", OTHER_MANIFEST, new Error(SECRET)),
  ]);
  const snapshot = await captureBlocksManifestQueryState(page, [MANIFEST]);
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.entries.length, 3);
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.errorCategory, entry.errorPhase]),
    [
      ["rate-limited", "manifest-load"],
      ["timeout", "trust"],
      ["none", "unknown"],
    ],
  );
  assert.equal(snapshot.entries[0].failureCount, 2);
  assert.equal(JSON.stringify(snapshot).includes(SECRET), false);
  assert.equal(JSON.stringify(snapshot).includes(OTHER_MANIFEST), false);
});

test("query state caps rows and sanitizes unexpected status and failure values", async (t) => {
  const page = queryPage(
    t,
    Array.from({ length: 12 }, () =>
      query("block-data", MANIFEST, SECRET, {
        status: { private: SECRET, toString: () => "success" },
        fetchStatus: { private: SECRET, toString: () => "idle" },
        fetchFailureCount: Number.POSITIVE_INFINITY,
      }),
    ),
  );
  const snapshot = await captureBlocksManifestQueryState(page, [MANIFEST]);
  assert.equal(snapshot.entries.length, 10);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.entries[0].status, "unknown");
  assert.equal(snapshot.entries[0].failureCount, 0);
  assert.equal(JSON.stringify(snapshot).includes(SECRET), false);
});

test("resolved query errors expose only their boolean and allowlisted result code", async (t) => {
  const page = queryPage(
    t,
    ["missing-manifest", "unavailable", SECRET].map((code) =>
      query("block-manifest", MANIFEST, null, {
        status: "success",
        data: { ok: false, code, message: SECRET, value: SECRET },
      }),
    ),
  );
  const snapshot = await captureBlocksManifestQueryState(page, [MANIFEST]);
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.resultOk, entry.resultCode]),
    [
      [false, "missing-manifest"],
      [false, "unavailable"],
      [false, null],
    ],
  );
  assert.equal(JSON.stringify(snapshot).includes(SECRET), false);
});

test("closed or stalled pages return bounded unavailable diagnostics", async (t) => {
  assert.equal(
    (
      await captureBlocksManifestQueryState(
        {
          evaluate: async () => {
            throw new Error(SECRET);
          },
        },
        [MANIFEST],
      )
    ).available,
    false,
  );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = captureBlocksManifestQueryState(
    { evaluate: () => new Promise(() => {}) },
    [MANIFEST],
  );
  t.mock.timers.tick(5_000);
  assert.equal((await pending).available, false);
});
