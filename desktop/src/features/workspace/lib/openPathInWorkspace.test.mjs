import assert from "node:assert/strict";
import test from "node:test";

import {
  openPathInWorkspace,
  tabKindForResolvedPath,
} from "./openPathInWorkspace.ts";

function resolved(path, mime, isText = true) {
  return { path, mime, is_text: isText };
}

function harness(resolvePath, kinds = ["file", "image"]) {
  const calls = [];
  return {
    calls,
    dependencies: {
      getKind: (kind) => (kinds.includes(kind) ? {} : undefined),
      openTab: (channelId, tab) => {
        calls.push(["tab", channelId, tab]);
        return "tab-1";
      },
      resolvePath,
      setSurfaceMode: (channelId, mode) => {
        calls.push(["mode", channelId, mode]);
      },
    },
  };
}

test("images open in the image kind, everything else in the file kind", () => {
  assert.equal(
    tabKindForResolvedPath(resolved("/w/a.png", "image/png", false)),
    "image",
  );
  assert.equal(
    tabKindForResolvedPath(resolved("/w/a.md", "text/markdown")),
    "file",
  );
  assert.equal(
    tabKindForResolvedPath(
      resolved("/w/a.bin", "application/octet-stream", false),
    ),
    "file",
  );
});

test("a resolved path opens as a tab and switches the channel to workspace", async () => {
  const { calls, dependencies } = harness(async () =>
    resolved("/w/PLANS/FOO.md", "text/markdown"),
  );

  const result = await openPathInWorkspace(
    { channelId: "channel-1", path: "PLANS/FOO.md" },
    dependencies,
  );

  assert.deepEqual(result, {
    ok: true,
    kind: "file",
    path: "/w/PLANS/FOO.md",
    tabId: "tab-1",
  });
  assert.deepEqual(calls, [
    [
      "tab",
      "channel-1",
      {
        kind: "file",
        title: "FOO.md",
        createdBy: "local",
        payload: { path: "/w/PLANS/FOO.md" },
      },
    ],
    ["mode", "channel-1", "workspace"],
  ]);
});

test("a path the native side refuses reports why and opens nothing", async () => {
  const { calls, dependencies } = harness(async () => {
    throw "secret.txt is not a file in the Buzz workspace or your repos folder";
  });

  const result = await openPathInWorkspace(
    { channelId: "channel-1", path: "../secret.txt" },
    dependencies,
  );

  assert.deepEqual(result, {
    ok: false,
    message:
      "secret.txt is not a file in the Buzz workspace or your repos folder",
  });
  assert.deepEqual(calls, []);
});

test("a build without the needed tab kind opens nothing", async () => {
  const { calls, dependencies } = harness(
    async () => resolved("/w/a.png", "image/png", false),
    ["file"],
  );

  const result = await openPathInWorkspace(
    { channelId: "channel-1", path: "shots/a.png" },
    dependencies,
  );

  assert.deepEqual(result, {
    ok: false,
    message: "This build cannot open /w/a.png in the workspace.",
  });
  assert.deepEqual(calls, []);
});
