import assert from "node:assert/strict";
import { test } from "node:test";

import { createdTables, findDrift } from "./check-schema-drift.mjs";

test("a table only in migrations is drift", () => {
  assert.deepEqual(
    findDrift("CREATE TABLE employees (id UUID);", "CREATE TABLE events (id UUID);"),
    ["employees"],
  );
});

test("a table in both is not drift", () => {
  assert.deepEqual(
    findDrift("CREATE TABLE events (id UUID);", "CREATE TABLE events (id UUID);"),
    [],
  );
});

test("IF NOT EXISTS is matched on either side", () => {
  // migrations/0043 writes `IF NOT EXISTS`, schema.sql is mixed. A guard that
  // only matched the bare form would have reported every such table as drift
  // and been switched off within a day.
  assert.deepEqual(
    findDrift(
      "CREATE TABLE IF NOT EXISTS employees (id UUID);",
      "CREATE TABLE employees (id UUID);",
    ),
    [],
  );
  assert.deepEqual(
    findDrift(
      "CREATE TABLE employees (id UUID);",
      "CREATE TABLE IF NOT EXISTS employees (id UUID);",
    ),
    [],
  );
});

test("partition children are not drift", () => {
  // CI creates these with scripts/attach-schema-partitions.sql, so they are
  // deliberately absent from schema.sql. Counting them would produce dozens of
  // false positives, one per month of `events_p2026_NN`.
  assert.deepEqual(
    findDrift(
      "CREATE TABLE events (id UUID) PARTITION BY RANGE (created_at);\n" +
        "CREATE TABLE events_p2026_01 PARTITION OF events FOR VALUES FROM ('a') TO ('b');",
      "CREATE TABLE events (id UUID) PARTITION BY RANGE (created_at);",
    ),
    [],
  );
});

test("a partitioned parent is still drift when schema.sql lacks it", () => {
  assert.deepEqual(
    findDrift("CREATE TABLE delivery_log (id UUID) PARTITION BY RANGE (at);", ""),
    ["delivery_log"],
  );
});

test("createdTables is case-insensitive and ignores column names", () => {
  const t = createdTables(
    "create table Foo (\n  create_table_like_column TEXT\n);\nCREATE TABLE bar (x INT);",
  );
  assert.deepEqual([...t].sort(), ["Foo", "bar"]);
});

test("drift is reported sorted and deduplicated across migrations", () => {
  assert.deepEqual(
    findDrift(
      "CREATE TABLE zebra (x INT);\nCREATE TABLE apple (x INT);\n" +
        "CREATE TABLE IF NOT EXISTS apple (x INT);",
      "",
    ),
    ["apple", "zebra"],
  );
});

test("the repo's real schema has no drift beyond KNOWN_DRIFT", async () => {
  // The end-to-end assertion: runs the real check against the real files, so
  // this test fails the moment someone adds a table to migrations/ only.
  const { default: cp } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const r = cp.spawnSync(process.execPath, [join(here, "check-schema-drift.mjs")], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `check-schema-drift failed:\n${r.stderr}${r.stdout}`);
});
