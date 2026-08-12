import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideTaskArtifactOpening,
  openTaskArtifact,
} from "./openTaskArtifact.ts";

const EVENT_ID = "a".repeat(64);
const AUTHOR = "b".repeat(64);

test("text and registered URL artifacts map to existing workspace kinds", () => {
  assert.deepEqual(
    decideTaskArtifactOpening(
      { kind: "text", reference: "# Memo", label: "Launch memo" },
      () => true,
    ),
    { kind: "artifact", supported: true },
  );
  assert.deepEqual(
    decideTaskArtifactOpening(
      { kind: "url", reference: "https://example.com", label: null },
      (kind) => kind === "web",
    ),
    { kind: "web", supported: true },
  );
});

test("URL without web support and every path have truthful non-local fallbacks", () => {
  assert.deepEqual(
    decideTaskArtifactOpening(
      { kind: "url", reference: "https://example.com", label: null },
      () => false,
    ),
    {
      supported: false,
      message:
        "This build cannot open web evidence in-app. The accepted URL remains available below.",
    },
  );
  assert.deepEqual(
    decideTaskArtifactOpening(
      { kind: "path", reference: "/worker/output/final.png", label: "Final" },
      () => true,
    ),
    {
      supported: false,
      message:
        "This path belongs to the worker workspace and is not available on this device.",
    },
  );
});

test("opening inline text uses a read-only artifact tab and workspace mode", async () => {
  const calls = [];
  const result = await openTaskArtifact(
    {
      channelId: "engineering",
      artifact: { kind: "text", reference: "# Memo", label: "Launch memo" },
      createdBy: AUTHOR,
    },
    {
      getKind: () => ({}),
      getEvent: async () => {
        throw new Error("must not fetch text");
      },
      openTab: (channelId, tab) => calls.push(["tab", channelId, tab]),
      setSurfaceMode: (channelId, mode) =>
        calls.push(["mode", channelId, mode]),
    },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0][2].kind, "artifact");
  assert.deepEqual(calls[0][2].payload, {
    content: "# Memo",
    reference: "# Memo",
    sourceEventId: null,
    sourceKind: "text",
  });
  assert.deepEqual(calls[1], ["mode", "engineering", "workspace"]);
});

test("event opening verifies the exact returned ID before making a tab", async () => {
  let opened = false;
  const deps = {
    getKind: () => ({}),
    getEvent: async () => ({
      id: "c".repeat(64),
      pubkey: AUTHOR,
      content: "forged",
    }),
    openTab: () => {
      opened = true;
    },
    setSurfaceMode: () => {},
  };
  const refused = await openTaskArtifact(
    {
      channelId: "engineering",
      artifact: { kind: "event", reference: EVENT_ID, label: "Memo" },
      createdBy: AUTHOR,
    },
    deps,
  );
  assert.equal(refused.ok, false);
  assert.equal(opened, false);

  deps.getEvent = async () => ({
    id: EVENT_ID,
    pubkey: AUTHOR,
    content: "# Accepted",
  });
  const accepted = await openTaskArtifact(
    {
      channelId: "engineering",
      artifact: { kind: "event", reference: EVENT_ID, label: "Memo" },
      createdBy: AUTHOR,
    },
    deps,
  );
  assert.deepEqual(accepted, { ok: true });
  assert.equal(opened, true);
});

test("path fallback never opens a tab or fetches a device-local file", async () => {
  let touched = false;
  const result = await openTaskArtifact(
    {
      channelId: "engineering",
      artifact: { kind: "path", reference: "/worker/output.png", label: null },
      createdBy: AUTHOR,
    },
    {
      getKind: () => ({}),
      getEvent: async () => {
        touched = true;
        throw new Error("no");
      },
      openTab: () => {
        touched = true;
      },
      setSurfaceMode: () => {
        touched = true;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.equal(touched, false);
});
