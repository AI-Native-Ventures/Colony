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
// KNOWN_DRIFT below is a burn-down list, not a permanent exemption. It exists
// so this guard can land without blocking twelve tables' worth of other
// people's in-flight work. Removing an entry means adding that table to
// schema.sql. Adding an entry means you are knowingly shipping a table CI
// cannot see -- do not, unless you also know no CI job will ever touch it.

import { readFileSync, readdirSync } from "node:fs";
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
  ["accounts", "credits, in flight on #170"],
  ["credit_ledger", "credits, in flight on #170"],
  ["gateway_tokens", "credits, in flight on #170"],
  ["model_catalog", "credits, in flight on #170"],
  ["discovery_lead_profiles", "discovery, owned elsewhere"],
  ["company_action_claims", "being added by #181"],
  ["party_action_claims", "same broker shape as company_action_claims; fails the same way once a party suite runs"],
  ["ledger_action_claims", "same broker shape as company_action_claims"],
  ["jobs", "unowned"],
  ["git_repo_names", "unowned"],
  ["product_feedback", "unowned"],
  ["parameterized_event_watermarks", "unowned"],
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

  if (fixed.length > 0) {
    console.error(
      `These tables are now in schema.sql, so remove them from KNOWN_DRIFT ` +
        `in ${"scripts/check-schema-drift.mjs"}:\n` +
        fixed.map((t) => `  ${t}`).join("\n"),
    );
    process.exit(1);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
