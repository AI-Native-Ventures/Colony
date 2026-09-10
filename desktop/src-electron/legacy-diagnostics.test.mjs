import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectSyntheticWebKitMetadata,
  summarizeLegacyEntries,
} from "./onboarding-fixture/legacy-diagnostics.mjs";

test("legacy diagnostic hashes compare state without exposing entry keys or values", () => {
  const entries = [
    ["buzz-private-fixture-name", "synthetic-sensitive-value"],
    ["buzz-theme", "dark"],
  ];
  const summary = summarizeLegacyEntries(entries);
  assert.deepEqual(summary, summarizeLegacyEntries([...entries].reverse()));
  assert.notEqual(
    summary.sha256,
    summarizeLegacyEntries([["buzz-theme", "light"]]).sha256,
  );
  assert.equal(summary.count, 2);
  assert.deepEqual(Object.keys(summary).sort(), ["count", "sha256"]);
  assert.ok(!JSON.stringify(summary).includes("synthetic-sensitive-value"));
  assert.ok(!JSON.stringify(summary).includes("buzz-private-fixture-name"));
});

test("legacy diagnostic metadata stays within synthetic stores and refuses redirected roots", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "legacy-diagnostics-test-"),
  );
  try {
    const root = path.join(
      home,
      "Library/WebKit/ventures.ainative.colony.onboarding-fixture",
    );
    await mkdir(root, { recursive: true });
    await writeFile(
      path.join(root, "fixture.localstorage"),
      "synthetic database contents never printed",
    );
    const other = path.join(home, "Library/WebKit/xyz.block.buzz.app");
    await mkdir(other);
    await writeFile(path.join(other, "must-not-be-listed"), "not the fixture");
    await symlink(other, path.join(root, "do-not-follow"));
    const redirected = path.join(
      home,
      "Library/Containers/ventures.ainative.colony.onboarding-fixture",
    );
    await mkdir(path.dirname(redirected), { recursive: true });
    await symlink(other, redirected);

    const stores = await collectSyntheticWebKitMetadata(home);
    assert.equal(stores[0].status, "observed");
    assert.ok(
      stores[0].entries.some(
        (entry) =>
          entry.path === "fixture.localstorage" && entry.type === "file",
      ),
    );
    assert.ok(
      stores[0].entries.some(
        (entry) => entry.path === "do-not-follow" && entry.type === "symlink",
      ),
    );
    assert.equal(stores[1].status, "symlink-refused");
    assert.deepEqual(stores[1].entries, []);
    const serialized = JSON.stringify(stores);
    for (const forbidden of [
      "must-not-be-listed",
      "synthetic database contents",
      "not the fixture",
      "xyz.block.buzz.app",
    ]) {
      assert.ok(!serialized.includes(forbidden));
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
