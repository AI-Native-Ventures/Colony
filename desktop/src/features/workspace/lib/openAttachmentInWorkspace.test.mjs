import assert from "node:assert/strict";
import test from "node:test";

import { openAttachmentInWorkspace } from "./openAttachmentInWorkspace.ts";

const PDF = {
  url: "https://relay.example/media/abc.pdf",
  filename: "Q3-budget.pdf",
  mime: "application/pdf",
};

function harness(kinds = ["file", "image"]) {
  const calls = [];
  return {
    calls,
    dependencies: {
      getKind: (kind) => (kinds.includes(kind) ? {} : undefined),
      openTab: (channelId, tab) => {
        calls.push(["tab", channelId, tab]);
        return "tab-1";
      },
      setSurfaceMode: (channelId, mode) => {
        calls.push(["mode", channelId, mode]);
      },
    },
  };
}

test("an attachment opens as a tab carrying its URL, not a local path", () => {
  const { calls, dependencies } = harness();

  const result = openAttachmentInWorkspace(
    { attachment: PDF, channelId: "channel-1" },
    dependencies,
  );

  assert.deepEqual(result, {
    ok: true,
    tabId: "tab-1",
    title: "Q3-budget.pdf",
  });
  assert.deepEqual(calls, [
    [
      "tab",
      "channel-1",
      {
        kind: "file",
        title: "Q3-budget.pdf",
        createdBy: "local",
        payload: {
          url: PDF.url,
          name: "Q3-budget.pdf",
          mime: "application/pdf",
        },
      },
    ],
    ["mode", "channel-1", "workspace"],
  ]);
});

test("a build without the needed tab kind opens nothing", () => {
  const { calls, dependencies } = harness([]);

  const result = openAttachmentInWorkspace(
    { attachment: PDF, channelId: "channel-1" },
    dependencies,
  );

  assert.deepEqual(result, {
    ok: false,
    message: "This build cannot open Q3-budget.pdf in the workspace.",
  });
  assert.deepEqual(calls, []);
});
