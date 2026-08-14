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
export const KNOWN_DRIFT = new Map([
  ["product_feedback", "unowned"],
]);

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

/** Tables in `migrations/` that `schema/schema.sql` does not create. */
export function findDrift(migrationsSql, schemaSql) {
  const inSchema = createdTables(schemaSql);
  const missing = [];
  for (const name of [...createdTables(migrationsSql)].sort()) {
    if (!inSchema.has(name)) missing.push(name);
  }
  return missing;
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
  const missing = findDrift(
    readMigrations(),
    readFileSync(join(REPO_ROOT, "schema/schema.sql"), "utf8"),
  );

  const unexpected = missing.filter((t) => !KNOWN_DRIFT.has(t));
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

  if (unexpected.length > 0) {
    console.error(
      `These tables exist in migrations/ but not in schema/schema.sql, so a\n` +
        `CI database will not have them and any suite touching them will fail\n` +
        `with an error that does not mention the table:\n` +
        unexpected.map((t) => `  ${t}`).join("\n") +
        `\n\nAdd each CREATE TABLE (and its indexes) to schema/schema.sql.`,
    );
    process.exit(1);
  }

  const n = KNOWN_DRIFT.size;
  console.log(
    `schema.sql covers every table in migrations/, except ${n} known and ` +
      `listed in KNOWN_DRIFT.`,
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
