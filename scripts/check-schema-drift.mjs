#!/usr/bin/env node
// Fail when a table exists in `migrations/` but not in `schema/schema.sql`.
//
// Why this can silently break CI
// ------------------------------
// Two things provision a Buzz database and they are not the same thing:
//
//   developer     `createdb` + the sqlx migrator  -> every table in migrations/
//   CI            `pgschema apply --file schema/schema.sql`, relay started
//                 WITHOUT BUZZ_AUTO_MIGRATE      -> only what schema.sql has
//
// schema.sql is hand-maintained, so a table added only to `migrations/` is
// invisible to CI. Nothing notices until a suite finally exercises the code
// path that touches it, and then it surfaces as a product bug rather than a
// provisioning one. Both real instances looked nothing like a missing table:
//
//   employees missing            -> `create DM failed: 403 Forbidden`, because
//                                   the owner-contact gate could not resolve
//                                   any rank and failed closed
//   company_action_claims missing -> `company action ... accepted=false`, so
//                                   every Company/Initiative/Task write was
//                                   refused and no head was ever authored
//
// Partition children (`CREATE TABLE ... PARTITION OF ...`) are excluded: CI
// creates those with scripts/attach-schema-partitions.sql, not schema.sql.
//
// KNOWN_DRIFT below is a burn-down list, not a permanent exemption. Adding an
// entry means you are knowingly shipping a table CI cannot see -- do not,
// unless you also know no CI job will ever touch it.
//
// The check is deliberately ASYMMETRIC. New drift fails; a listed table that
// has since been added to schema.sql only warns. A hardcoded list in a repo
// that merges every twenty minutes goes stale between authoring and merging,
// and failing on the paid-down direction punishes the person who did the
// right thing by breaking a required check for every open PR.

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Tables present in migrations but not yet in schema.sql, each with the
 * reason it has not been fixed here. Every one of these is a live trap: the
 * day a CI job exercises its code path, that job goes red with an error that
 * does not mention the table.
 */
export const KNOWN_DRIFT = new Map([]);

/** Table names created by `text`, excluding partition children. */
export function createdTables(text) {
  const found = new Set();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z_0-9]*)([^;]*)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, name, rest] = m;
    if (/\bPARTITION\s+OF\b/i.test(rest)) continue;
    found.add(name);
  }
  return found;
}

/**
 * Columns declared directly in CREATE TABLE bodies, keyed by table.
 *
 * Only the FIRST token of each paren-depth-1 line counts, minus the
 * table-constraint keywords, so `CHECK (...)`, `PRIMARY KEY (...)` and friends
 * are never mistaken for columns. This is deliberately conservative: the goal
 * is zero false positives on today's files, not full SQL parsing.
 */
function columnsFromCreateBodies(text, into) {
  // The closing paren of every CREATE TABLE in this repo sits at column 0
  // (" );" / ");;" / ") PARTITION BY"), so anchor on that instead of the first
  // semicolon: comments inside a table body can contain semicolons, which
  // would otherwise truncate the body and silently drop the table.
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z_0-9]*)\s*\((.*?)^\)(?:\s*;;|;|\s+PARTITION\s+BY)/gims;
  const CONSTRAINT_KEYWORDS = new Set([
    "PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT", "EXCLUDE",
    "LIKE", "INHERITS",
  ]);
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, name, body] = m;
    if (!into.has(name)) into.set(name, new Set());
    const cols = into.get(name);
    let depth = 1;
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("--") || line.length === 0) continue;
      const openDelta = (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
      if (depth === 1 && !line.startsWith(")")) {
        const tok = /^([a-zA-Z_][a-zA-Z_0-9]*)/.exec(line);
        if (tok && !CONSTRAINT_KEYWORDS.has(tok[1].toUpperCase())) cols.add(tok[1]);
      }
      depth += openDelta;
      if (depth <= 0) break;
    }
  }
  return into;
}

/**
 * Columns added or dropped by `ALTER TABLE ... ADD/DROP COLUMN`, applied in
 * file order so a drop/re-add sequence lands on the final state. Only the
 * explicit `ADD COLUMN` / `DROP COLUMN` spellings count; anything else in an
 * ALTER clause changes no column names.
 */
function applyAlterColumns(text, into) {
  const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z_0-9]*)\s+([^;]*?);/gi;
  let m;
  while ((m = alterRe.exec(text)) !== null) {
    const [, name, clauses] = m;
    if (!/\b(ADD|DROP)\s+COLUMN\b/i.test(clauses)) continue;
    // Split the clause list on commas at paren depth 0.
    const parts = [];
    let depth = 0, cur = "";
    for (const ch of clauses) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
      cur += ch;
    }
    parts.push(cur);
    if (!into.has(name)) into.set(name, new Set());
    const cols = into.get(name);
    for (const clauseRaw of parts) {
      const clause = clauseRaw.replace(/--[^\n]*/g, "").trim();
      let cm = /^ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z_0-9]*)/i.exec(clause);
      if (cm) { cols.add(cm[1]); continue; }
      cm = /^DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z_0-9]*)/i.exec(clause);
      if (cm) cols.delete(cm[1]);
    }
  }
  return into;
}

/** table -> Set<column> across a whole SQL text, in source order. */
export function createdColumns(text) {
  return applyAlterColumns(text, columnsFromCreateBodies(text, new Map()));
}

/** Tables in `migrations/` that `schema/schema.sql` does not create. */
export function findDrift(migrationsSql, schemaSql) {
  const inSchema = createdTables(schemaSql);
  const missing = [];
  for (const name of [...createdTables(migrationsSql)].sort()) {
    if (!inSchema.has(name)) missing.push(name);
  }
  return missing;
}

/**
 * Columns each side's shared tables are missing, as
 * `{ inMigrationsOnly: [[table, column], ...], inSchemaOnly: [...] }`.
 * Only tables that exist on both sides are compared here; a wholly missing
 * table is already reported by findDrift.
 */
export function findColumnDrift(migrationsSql, schemaSql) {
  const migCols = createdColumns(migrationsSql);
  const schCols = createdColumns(schemaSql);
  const inMigrationsOnly = [];
  const inSchemaOnly = [];
  for (const table of [...migCols.keys()].sort()) {
    const sch = schCols.get(table);
    if (!sch) continue;
    for (const col of migCols.get(table)) {
      if (!sch.has(col)) inMigrationsOnly.push([table, col]);
    }
  }
  for (const table of [...schCols.keys()].sort()) {
    const mig = migCols.get(table);
    if (!mig) continue;
    for (const col of schCols.get(table)) {
      if (!mig.has(col)) inSchemaOnly.push([table, col]);
    }
  }
  return { inMigrationsOnly, inSchemaOnly };
}

function readMigrations(root = REPO_ROOT) {
  const dir = join(root, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n");
}

function main() {
  const migrationsSql = readMigrations();
  const schemaSql = readFileSync(join(REPO_ROOT, "schema/schema.sql"), "utf8");

  const missing = findDrift(migrationsSql, schemaSql);
  const { inMigrationsOnly, inSchemaOnly } = findColumnDrift(migrationsSql, schemaSql);

  const unexpectedTables = missing.filter((t) => !KNOWN_DRIFT.has(t));
  const fixed = [...KNOWN_DRIFT.keys()].filter((t) => !missing.includes(t));

  // Warn, never fail. A listed table that has since been added to schema.sql
  // is drift paid down -- the good direction -- and failing on it means the
  // next person to fix a table breaks `Detect Changed Paths` for every open
  // PR until they also edit this file. That is exactly what happened the day
  // this guard landed: #170 and #181 merged between authoring and merging,
  // five entries went stale, and the required check failed repo-wide. The
  // protection this script exists for is the OTHER direction.
  if (fixed.length > 0) {
    console.warn(
      `These tables are now in schema.sql and can be dropped from ` +
        `KNOWN_DRIFT in scripts/check-schema-drift.mjs (not a failure):\n` +
        fixed.map((t) => `  ${t}`).join("\n"),
    );
  }

  if (unexpectedTables.length > 0) {
    console.error(
      `These tables exist in migrations/ but not in schema/schema.sql, so a\n` +
        `CI database will not have them and any suite touching them will fail\n` +
        `with an error that does not mention the table:\n` +
        unexpectedTables.map((t) => `  ${t}`).join("\n") +
        `\n\nAdd each CREATE TABLE (and its indexes) to schema/schema.sql.`,
    );
    process.exit(1);
  }

  if (inMigrationsOnly.length > 0) {
    console.error(
      `These columns exist in migrations/ but not in schema/schema.sql, so a\n` +
        `CI database will lack them and any query touching them fails with\n` +
        `ColumnNotFound. This is the 0060/pre_quiesce_archived_at failure class:\n` +
        inMigrationsOnly.map(([t, c]) => `  ${t}.${c}`).join("\n") +
        `\n\nMirror each column's definition into schema/schema.sql.`,
    );
    process.exit(1);
  }

  // Reverse-direction drift (a column only in schema.sql) is reported but does
  // not fail: it usually means the mirror got ahead of a pending migration, or
  // the parser missed a migration spelling. Failing on it would punish whoever
  // just fixed the forward direction, which is what made the original
  // table-level guard break repo-wide when entries went stale (#170, #181).
  if (inSchemaOnly.length > 0) {
    console.warn(
      `These columns are in schema/schema.sql but no migration creates them\n` +
        `(not a failure; check whether a migration is still pending):\n` +
        inSchemaOnly.map(([t, c]) => `  ${t}.${c}`).join("\n"),
    );
  }

  const n = KNOWN_DRIFT.size;
  console.log(
    `schema.sql covers every table and column in migrations/, except ${n} ` +
      `table(s) known and listed in KNOWN_DRIFT.`,
  );
}

/**
 * Whether this file is the entrypoint, compared by real path.
 *
 * A plain `process.argv[1] === fileURLToPath(import.meta.url)` is wrong the
 * moment either side traverses a symlink: on macOS `/tmp` resolves to
 * `/private/tmp`, so the two strings differ, `main()` never runs, and the
 * process exits 0 having checked nothing. A guard that silently does nothing
 * and reports success is the exact failure this script exists to catch.
 */
function isEntrypoint() {
  if (!process.argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) main();
