import assert from "node:assert/strict";
import test from "node:test";

import {
  decideWorkspaceUrlOpening,
  extractFirstHttpUrl,
  openLinkInWorkspace,
  openUrlInWorkspace,
  parseWorkspaceUrl,
} from "./openUrlInWorkspace.ts";

function webTab(id, url, title = "Web") {
  return {
    id,
    kind: "web",
    title,
    createdBy: "local",
    payload: { url },
  };
}

function dependenciesWithTabs(tabsByChannel = {}) {
  const calls = {
    getWorkspace: [],
    openTab: [],
    setActiveTab: [],
    setSurfaceMode: [],
  };
  return {
    calls,
    dependencies: {
      getKind: (kind) => (kind === "web" ? {} : undefined),
      getWorkspace: (channelId) => {
        calls.getWorkspace.push(channelId);
        const tabs = tabsByChannel[channelId] ?? [];
        return { tabs, activeTabId: tabs.at(-1)?.id ?? null };
      },
      openTab: (channelId, tab) => {
        calls.openTab.push([channelId, tab]);
        return "new-tab";
      },
      setActiveTab: (channelId, tabId) => {
        calls.setActiveTab.push([channelId, tabId]);
      },
      setSurfaceMode: (channelId, mode) => {
        calls.setSurfaceMode.push([channelId, mode]);
      },
    },
  };
}

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

test("trims prose punctuation without changing direct or stored URLs", () => {
  assert.equal(
    extractFirstHttpUrl("Read https://example.com/report."),
    "https://example.com/report",
  );
  assert.equal(
    parseWorkspaceUrl("https://example.com/report.")?.href,
    "https://example.com/report.",
  );

  const exact = dependenciesWithTabs({
    alpha: [webTab("exact", "https://example.com/report.", "Exact page")],
  });
  const exactResult = openLinkInWorkspace(
    { channelId: "alpha", href: "https://example.com/report." },
    exact.dependencies,
  );

  assert.deepEqual(exactResult, {
    ok: true,
    reused: true,
    tabId: "exact",
    title: "Exact page",
    url: "https://example.com/report.",
  });
  assert.deepEqual(exact.calls.openTab, []);

  const distinct = dependenciesWithTabs({
    alpha: [webTab("without-period", "https://example.com/report")],
  });
  const distinctResult = openLinkInWorkspace(
    { channelId: "alpha", href: "https://example.com/report." },
    distinct.dependencies,
  );

  assert.equal(distinctResult.ok, true);
  assert.equal(distinctResult.reused, false);
  assert.equal(distinct.calls.openTab.length, 1);
  assert.deepEqual(distinct.calls.setActiveTab, []);
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
      getWorkspace: () => ({ tabs: [], activeTabId: null }),
      openTab: (channelId, tab) => {
        calls.push(["tab", channelId, tab]);
        return "tab-1";
      },
      setActiveTab: () => {},
      setSurfaceMode: (channelId, mode) => {
        calls.push(["mode", channelId, mode]);
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    reused: false,
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

test("opens a clicked link without re-scanning the message for a URL", () => {
  const calls = [];
  const result = openLinkInWorkspace(
    { channelId: "channel-1", href: "https://second.example.com/page?q=1" },
    {
      getKind: (kind) => (kind === "web" ? {} : undefined),
      getWorkspace: () => ({ tabs: [], activeTabId: null }),
      openTab: (channelId, tab) => {
        calls.push(["tab", channelId, tab]);
        return "tab-2";
      },
      setActiveTab: () => {},
      setSurfaceMode: (channelId, mode) => {
        calls.push(["mode", channelId, mode]);
      },
    },
  );

  assert.deepEqual(result, {
    ok: true,
    reused: false,
    tabId: "tab-2",
    title: "second.example.com",
    url: "https://second.example.com/page?q=1",
  });
  assert.deepEqual(calls, [
    [
      "tab",
      "channel-1",
      {
        kind: "web",
        title: "second.example.com",
        createdBy: "local",
        payload: {
          endpoint: null,
          targetId: null,
          url: "https://second.example.com/page?q=1",
        },
      },
    ],
    ["mode", "channel-1", "workspace"],
  ]);
});

test("reuses a canonical Web URL in the current channel", () => {
  const { calls, dependencies } = dependenciesWithTabs({
    alpha: [webTab("existing", "https://example.com/", "Existing page")],
  });

  const result = openLinkInWorkspace(
    { channelId: "alpha", href: "https://example.com" },
    dependencies,
  );

  assert.deepEqual(result, {
    ok: true,
    reused: true,
    tabId: "existing",
    title: "Existing page",
    url: "https://example.com/",
  });
  assert.deepEqual(calls.getWorkspace, ["alpha"]);
  assert.deepEqual(calls.openTab, []);
  assert.deepEqual(calls.setActiveTab, [["alpha", "existing"]]);
  assert.deepEqual(calls.setSurfaceMode, [["alpha", "workspace"]]);
});

test("keeps path, query, and hash differences as separate Web tabs", () => {
  for (const href of [
    "https://example.com/other",
    "https://example.com/path?view=two",
    "https://example.com/path?view=one#details",
  ]) {
    const { calls, dependencies } = dependenciesWithTabs({
      alpha: [webTab("existing", "https://example.com/path?view=one")],
    });

    const result = openLinkInWorkspace(
      { channelId: "alpha", href },
      dependencies,
    );

    assert.equal(result.ok, true);
    assert.equal(result.reused, false);
    assert.equal(result.tabId, "new-tab");
    assert.equal(calls.openTab.length, 1);
    assert.deepEqual(calls.setActiveTab, []);
    assert.deepEqual(calls.setSurfaceMode, [["alpha", "workspace"]]);
  }
});

test("does not reuse a matching Web tab from another channel", () => {
  const { calls, dependencies } = dependenciesWithTabs({
    alpha: [webTab("alpha-tab", "https://example.com/")],
    beta: [],
  });

  const result = openLinkInWorkspace(
    { channelId: "beta", href: "https://example.com" },
    dependencies,
  );

  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.deepEqual(calls.getWorkspace, ["beta"]);
  assert.equal(calls.openTab.length, 1);
  assert.deepEqual(calls.setActiveTab, []);
  assert.deepEqual(calls.setSurfaceMode, [["beta", "workspace"]]);
});

test("ignores malformed Web payloads and matching non-Web tabs", () => {
  const malformedTabs = [
    { ...webTab("null-payload", "unused"), payload: null },
    { ...webTab("non-string", "unused"), payload: { url: 42 } },
    { ...webTab("unsafe", "unused"), payload: { url: "javascript:alert(1)" } },
    { ...webTab("malformed", "unused"), payload: { url: "not a URL" } },
    {
      ...webTab("credentials", "unused"),
      payload: { url: "https://user:password@example.com/" },
    },
    {
      ...webTab("matching-file", "https://example.com/"),
      kind: "file",
    },
  ];
  const { calls, dependencies } = dependenciesWithTabs({
    alpha: malformedTabs,
  });

  const result = openLinkInWorkspace(
    { channelId: "alpha", href: "https://example.com" },
    dependencies,
  );

  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(calls.openTab.length, 1);
  assert.deepEqual(calls.setActiveTab, []);
  assert.deepEqual(calls.setSurfaceMode, [["alpha", "workspace"]]);
});

test("declines a clicked link the workspace browser must not load", () => {
  const reject = () => {
    throw new Error("must not open a tab");
  };
  for (const href of [
    "javascript:alert(1)",
    "file:///tmp/report",
    "https://user:password@example.com",
    "buzz://message?channel=c&id=1",
  ]) {
    assert.deepEqual(
      openLinkInWorkspace(
        { channelId: "channel-1", href },
        { getKind: () => ({}), openTab: reject, setSurfaceMode: reject },
      ),
      { ok: false, message: "This is not a safe HTTP or HTTPS link." },
      `expected ${href} to be declined`,
    );
  }

  assert.deepEqual(
    openLinkInWorkspace(
      { channelId: "channel-1", href: "https://example.com" },
      { getKind: () => undefined, openTab: reject, setSurfaceMode: reject },
    ),
    {
      ok: false,
      message:
        "This build cannot open web links in the workspace. Enable the workspace web tab to use this action.",
    },
  );
});

test("returns a user-facing error when opening the tab fails", () => {
  const result = openUrlInWorkspace(
    { body: "https://example.com", channelId: "channel-1" },
    {
      getKind: () => ({}),
      getWorkspace: () => ({ tabs: [], activeTabId: null }),
      openTab: () => {
        throw new Error("workspace unavailable");
      },
      setActiveTab: () => {
        throw new Error("must not activate an existing tab");
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
