import assert from "node:assert/strict";
import test from "node:test";

import {
  decideWorkspaceUrlOpening,
  extractFirstHttpUrl,
  openUrlInWorkspace,
  parseWorkspaceUrl,
} from "./openUrlInWorkspace.ts";

test("extracts the first safe URL from markdown and plain text", () => {
  assert.equal(
    extractFirstHttpUrl(
      "Read [the docs](https://docs.example.com/guide), then visit https://later.example.test.",
    ),
    "https://docs.example.com/guide",
  );
  assert.equal(
    extractFirstHttpUrl("A balanced path is https://example.com/a_(b)."),
    "https://example.com/a_(b)",
  );
  assert.deepEqual(
    decideWorkspaceUrlOpening("https://www.example.com", () => true),
    {
      supported: true,
      title: "www.example.com",
      url: "https://www.example.com/",
    },
  );
});

test("rejects unsafe schemes, credentials, and malformed URL candidates", () => {
  assert.equal(parseWorkspaceUrl("javascript:alert(1)"), null);
  assert.equal(parseWorkspaceUrl("file:///tmp/report"), null);
  assert.equal(parseWorkspaceUrl("https://user:password@example.com"), null);
  assert.equal(
    extractFirstHttpUrl(
      "Bad https://user:password@example.com then https://safe.example",
    ),
    null,
  );
  assert.equal(
    extractFirstHttpUrl(
      "Bad javascript:alert(1) and file:///tmp/report, then https://safe.example",
    ),
    "https://safe.example/",
  );
});

test("does not offer opening when the web tab kind is unavailable", () => {
  assert.deepEqual(
    decideWorkspaceUrlOpening("See https://example.com", () => false),
    {
      supported: false,
      message:
        "This build cannot open web links in the workspace. Enable the workspace web tab to use this action.",
    },
  );
});

test("opens the safe URL as a web tab and switches the channel to workspace", () => {
  const calls = [];
  const result = openUrlInWorkspace(
    { body: "Open https://docs.example.com/guide.", channelId: "channel-1" },
    {
      getKind: (kind) => (kind === "web" ? {} : undefined),
      openTab: (channelId, tab) => {
        calls.push(["tab", channelId, tab]);
        return "tab-1";
      },
      setSurfaceMode: (channelId, mode) => {
        calls.push(["mode", channelId, mode]);
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    tabId: "tab-1",
    title: "docs.example.com",
    url: "https://docs.example.com/guide",
  });
  assert.deepEqual(calls, [
    [
      "tab",
      "channel-1",
      {
        kind: "web",
        title: "docs.example.com",
        createdBy: "local",
        payload: {
          endpoint: null,
          targetId: null,
          url: "https://docs.example.com/guide",
        },
      },
    ],
    ["mode", "channel-1", "workspace"],
  ]);
});

test("returns a user-facing error when opening the tab fails", () => {
  const result = openUrlInWorkspace(
    { body: "https://example.com", channelId: "channel-1" },
    {
      getKind: () => ({}),
      openTab: () => {
        throw new Error("workspace unavailable");
      },
      setSurfaceMode: () => {
        throw new Error("must not reach surface mode");
      },
    },
  );

  assert.deepEqual(result, {
    ok: false,
    message:
      "This link could not be opened in the workspace: Error: workspace unavailable",
  });
});
