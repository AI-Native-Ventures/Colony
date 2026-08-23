import assert from "node:assert/strict";
import { test } from "node:test";

import { createdColumns, createdTables, findColumnDrift, findDrift } from "./check-schema-drift.mjs";

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

test("a column added by ALTER TABLE is drift when schema.sql lacks it", () => {
  // The 0060 failure class: pre_quiesce_archived_at shipped in a migration,
  // never entered the mirror, and the Postgres-gated suite died on
  // ColumnNotFound against a CI database provisioned from schema.sql.
  const migrationsSql =
    "CREATE TABLE requests (id UUID, stage TEXT);\n" +
    "ALTER TABLE requests ADD COLUMN pre_quiesce_archived_at TIMESTAMPTZ;";
  const schemaSql = "CREATE TABLE requests (\n    id UUID,\n    stage TEXT\n);";
  assert.deepEqual(findColumnDrift(migrationsSql, schemaSql).inMigrationsOnly, [
    ["requests", "pre_quiesce_archived_at"],
  ]);
});

test("multi-clause ALTER TABLE adds every named column", () => {
  const migrationsSql =
    "ALTER TABLE discovery_runs\n" +
    "    ADD COLUMN worker_id UUID,\n" +
    "    ADD COLUMN lease_owner_pubkey BYTEA CHECK (octet_length(lease_owner_pubkey) = 32),\n" +
    "    ADD CONSTRAINT shape CHECK (worker_id IS NULL OR worker_id IS NOT NULL);";
  const cols = createdColumns(migrationsSql).get("discovery_runs");
  assert.deepEqual([...cols].sort(), ["lease_owner_pubkey", "worker_id"]);
});

test("DROP COLUMN then re-add lands on the final state", () => {
  // search_tsv was rebuilt several times; only the last spelling counts.
  const text =
    "CREATE TABLE events (\n    id UUID,\n    old_col TEXT\n);\n" +
    "ALTER TABLE events DROP COLUMN old_col;\n" +
    "ALTER TABLE events DROP COLUMN search_tsv;\n" +
    "ALTER TABLE events ADD COLUMN search_tsv TSVECTOR GENERATED ALWAYS AS (NULL) STORED;";
  const cols = createdColumns(text).get("events");
  assert.deepEqual([...cols].sort(), ["id", "search_tsv"]);
});

test("table-constraint lines and comments are not columns", () => {
  const text =
    "CREATE TABLE t (\n" +
    "    -- a comment mentioning ghost_column should not count\n" +
    "    id UUID PRIMARY KEY,\n" +
    "    payload TEXT CHECK (length(payload) > 0),\n" +
    "    PRIMARY KEY (id),\n" +
    "    UNIQUE (payload),\n" +
    "    CONSTRAINT c CHECK (payload <> 'x'),\n" +
    "    FOREIGN KEY (id) REFERENCES other (id)\n" +
    ");";
  assert.deepEqual([...createdColumns(text).get("t")], ["id", "payload"]);
});

test("a semicolon inside a comment does not truncate the table body", () => {
  // The real files contain comments like "(Quinn option A; Max's caveat)".
  // A body parser that stops at the first semicolon silently loses every
  // column after the comment -- and reported nothing, which is worse than
  // crashing.
  const text =
    "CREATE TABLE t (\n" +
    "    -- keep in sync (Quinn option A; Max's caveat: avoid btree_gin).\n" +
    "    id UUID PRIMARY KEY,\n" +
    "    late_column TEXT\n" +
    ");";
  assert.deepEqual([...createdColumns(text).get("t")].sort(), [
    "id",
    "late_column",
  ]);
});

test("partition children contribute no columns", () => {
  const text =
    "CREATE TABLE events_p2026_01 PARTITION OF events FOR VALUES FROM ('a') TO ('b');";
  assert.equal(createdColumns(text).size, 0);
});

test("a paid-down entry warns but does not fail", async () => {
  // The regression that broke develop: #170 and #181 merged between this
  // guard being authored and merged, five KNOWN_DRIFT entries became stale,
  // and the required check failed repo-wide for doing the right thing.
  const { default: cp } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const r = cp.spawnSync(process.execPath, [join(here, "check-schema-drift.mjs")], {
    encoding: "utf8",
    env: { ...process.env },
  });
  // Every currently-listed table really is absent from schema.sql, so there is
  // nothing to warn about; the assertion that matters is that the paid-down
  // path cannot exit non-zero, which the source enforces by using console.warn
  // with no process.exit.
  const src = (await import("node:fs")).readFileSync(
    join(here, "check-schema-drift.mjs"),
    "utf8",
  );
  const paidDown = src.slice(src.indexOf("if (fixed.length > 0)"), src.indexOf("if (unexpectedTables.length > 0)"));
  assert.match(paidDown, /console\.warn/);
  assert.doesNotMatch(paidDown, /process\.exit/);
  assert.equal(r.status, 0);
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
  // Asserting on status ALONE would pass vacuously if main() never ran, which
  // is precisely how this script silently no-opped when its entrypoint check
  // compared unresolved paths across the /tmp -> /private/tmp symlink. The
  // guard has to prove it did something, not merely that it did not fail.
  assert.match(r.stdout, /schema\.sql covers every table and column/);
});

test("the entrypoint check survives a symlinked path", async () => {
  // Reproduces the real defect: on macOS `/tmp` resolves to `/private/tmp`, so
  // a raw string comparison of argv[1] against import.meta.url does not match
  // and the script exits 0 having checked nothing.
  const { default: cp } = await import("node:child_process");
  const { default: fs } = await import("node:fs");
  const { default: os } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));

  const dir = fs.mkdtempSync(join(os.tmpdir(), "drift-link-"));
  const link = join(dir, "check-schema-drift.mjs");
  fs.symlinkSync(join(here, "check-schema-drift.mjs"), link);
  const r = cp.spawnSync(process.execPath, [link], { encoding: "utf8" });
  fs.rmSync(dir, { recursive: true, force: true });

  assert.match(
    r.stdout,
    /schema\.sql covers every table/,
    `run through a symlink produced no output, so main() never ran:\n${r.stderr}`,
  );
});
