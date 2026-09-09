import assert from "node:assert/strict";
import test from "node:test";
import {
  collectLegacyState,
  importLegacyState,
  MIGRATION_MARKER,
} from "../public/electron-migration-state.mjs";

function store(entries = [], failAt = null) {
  const data = new Map(entries);
  return {
    data,
    get length() {
      return data.size;
    },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (key === failAt) throw new Error("storage full");
      data.set(key, value);
    },
    removeItem: (key) => data.delete(key),
  };
}

test("first upgrade retains community, identity scope, progress, unsent drafts and appearance", () => {
  const entries = [
    [
      "buzz-communities",
      '[{"id":"business","pubkey":"owner","relayUrl":"wss://business.example"}]',
    ],
    ["buzz-active-community-id", "business"],
    ["buzz-machine-onboarding-complete.v2:owner", "true"],
    [
      "buzz-community-onboarding-complete.v1:wss%3A%2F%2Fbusiness.example:owner",
      "true",
    ],
    ["buzz-onboarding-answers.v1", '{"companyName":"Saved business"}'],
    ["buzz-drafts.v1:owner", '{"thread:one":{"content":"Unsent work"}}'],
    ["buzz-theme", "orchid"],
    ["buzz-channel-messages.v1:cached", "disposable"],
    ["other-site-data", "not app state"],
  ];
  const source = store(entries);
  const target = store();
  const payload = collectLegacyState(source);
  assert.equal(importLegacyState(target, payload), 7);
  assert.equal(target.getItem("buzz-active-community-id"), "business");
  assert.equal(target.getItem("buzz-drafts.v1:owner"), entries[5][1]);
  assert.equal(target.getItem("buzz-theme"), "orchid");
  assert.equal(target.getItem("buzz-channel-messages.v1:cached"), null);
  assert.equal(target.getItem("other-site-data"), null);
  assert.equal(target.getItem(MIGRATION_MARKER), "complete");
  assert.deepEqual(
    [...source.data],
    entries,
    "rollback retains the untouched WebKit source",
  );
});

test("restart or an existing Electron preference never overwrites newer state", () => {
  const target = store([["buzz-theme", "new-theme"]]);
  assert.equal(
    importLegacyState(target, [
      ["buzz-theme", "old-theme"],
      ["buzz-communities", "[]"],
    ]),
    1,
  );
  target.setItem("buzz-communities", "newer community list");
  assert.equal(importLegacyState(target, [["buzz-communities", "[]"]]), 0);
  assert.equal(target.getItem("buzz-theme"), "new-theme");
  assert.equal(target.getItem("buzz-communities"), "newer community list");
});

test("failed persistence rolls back new entries, preserves existing ones and leaves migration retryable", () => {
  const target = store([["buzz-theme", "existing"]], "buzz-drafts.v1:owner");
  const payload = [
    ["buzz-communities", "[]"],
    ["buzz-drafts.v1:owner", "draft"],
  ];
  assert.throws(
    () => importLegacyState(target, payload),
    /reopen Colony to retry/,
  );
  assert.equal(target.getItem("buzz-communities"), null);
  assert.equal(target.getItem("buzz-theme"), "existing");
  assert.equal(target.getItem(MIGRATION_MARKER), null);
  assert.equal(importLegacyState(store(), payload), 2);
});

test("malformed, duplicate and oversized payloads cannot mark transfer complete", () => {
  for (const payload of [
    null,
    [["unrelated", "value"]],
    [["buzz-a", 42]],
    [
      ["buzz-a", "one"],
      ["buzz-a", "two"],
    ],
    [["buzz-a", "x".repeat(8 * 1024 * 1024)]],
  ]) {
    const target = store();
    assert.throws(() => importLegacyState(target, payload));
    assert.equal(target.getItem(MIGRATION_MARKER), null);
    assert.equal(target.length, 0);
  }
});

test("source storage failures propagate and a successful empty private profile can complete", () => {
  assert.throws(
    () =>
      collectLegacyState({
        get length() {
          throw new Error("locked storage");
        },
      }),
    /locked storage/,
  );
  const target = store();
  assert.equal(importLegacyState(target, collectLegacyState(store())), 0);
  assert.equal(target.getItem(MIGRATION_MARKER), "complete");
});
