import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

import {
  decideTaskArtifactOpening,
  openTaskArtifact,
  resetTaskArtifactOpeningState,
} from "./openTaskArtifact.ts";

const AUTHOR = "b".repeat(64);

function signedArtifact(content = "# Accepted") {
  return finalizeEvent(
    { kind: 1, created_at: 1_800_000_000, tags: [], content },
    generateSecretKey(),
  );
}

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

test("event opening requires the exact valid signed event before making a tab", async () => {
  let opened = false;
  const acceptedEvent = signedArtifact();
  const deps = {
    getKind: () => ({}),
    getEvent: async () => signedArtifact("different event"),
    openTab: () => {
      opened = true;
    },
    setSurfaceMode: () => {},
  };
  const refused = await openTaskArtifact(
    {
      channelId: "engineering",
      artifact: {
        kind: "event",
        reference: acceptedEvent.id,
        label: "Memo",
      },
      createdBy: AUTHOR,
    },
    deps,
  );
  assert.equal(refused.ok, false);
  assert.equal(opened, false);

  deps.getEvent = async () => ({ ...acceptedEvent, content: "tampered" });
  const tampered = await openTaskArtifact(
    {
      channelId: "engineering",
      artifact: {
        kind: "event",
        reference: acceptedEvent.id,
        label: "Memo",
      },
      createdBy: AUTHOR,
    },
    deps,
  );
  assert.equal(tampered.ok, false);
  assert.equal(opened, false);

  deps.getEvent = async () => acceptedEvent;
  const accepted = await openTaskArtifact(
    {
      channelId: "engineering",
      artifact: {
        kind: "event",
        reference: acceptedEvent.id,
        label: "Memo",
      },
      createdBy: AUTHOR,
    },
    deps,
  );
  assert.deepEqual(accepted, { ok: true });
  assert.equal(opened, true);
});

test("a pending event read cannot open into the next community", async () => {
  const event = signedArtifact();
  let release;
  let touched = false;
  const pending = openTaskArtifact(
    {
      channelId: "engineering",
      artifact: { kind: "event", reference: event.id, label: "Memo" },
      createdBy: AUTHOR,
    },
    {
      getKind: () => ({}),
      getEvent: () => new Promise((resolve) => (release = resolve)),
      openTab: () => {
        touched = true;
      },
      setSurfaceMode: () => {
        touched = true;
      },
    },
  );

  resetTaskArtifactOpeningState();
  release(event);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.message, /community changed/);
  assert.equal(touched, false);
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
