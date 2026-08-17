// Guards the `dorny/paths-filter` rules in .github/workflows/ci.yml against
// negated patterns.
//
// paths-filter ORs every pattern inside a rule, and picomatch reads a leading
// `!` as "matches every path that does NOT match the rest of the pattern". So
// `!desktop/src-tauri/**` sitting alongside `desktop/**` does not subtract the
// Tauri subtree — it makes the rule true for every file in the repository.
// The `desktop` rule carried exactly that line until 2026-08-17, which is why
// the four Desktop Smoke E2E shards ran on a README-only pull request.
//
// The failure is silent: the workflow parses, every job runs, and CI simply
// stops skipping anything. Nothing else in the repo would catch it, so this
// runs in `Detect Changed Paths`, which is required and unconditional. It uses
// no dependencies because that job never installs node_modules.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github/workflows/ci.yml");

/**
 * Extracts every `- 'pattern'` entry from the `filters: |` literal block,
 * tagged with the rule it belongs to and its 1-based line number.
 */
function readFilterPatterns(source) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^\s*filters:\s*\|\s*$/.test(line));
  assert.notEqual(
    start,
    -1,
    "no `filters: |` block in ci.yml — paths-filter was restructured, so update this contract instead of deleting it",
  );

  const blockIndent = lines[start].match(/^\s*/)[0].length;
  const patterns = [];
  let rule = null;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;

    const indent = line.match(/^\s*/)[0].length;
    if (indent <= blockIndent) break;

    const ruleMatch = line.match(/^\s*([\w-]+):\s*$/);
    if (ruleMatch) {
      rule = ruleMatch[1];
      continue;
    }

    const entryMatch = line.match(/^\s*-\s*'?([^']*)'?\s*$/);
    if (entryMatch) {
      patterns.push({ rule, pattern: entryMatch[1], line: index + 1 });
    }
  }

  return patterns;
}

test("ci.yml paths-filter rules contain no negated patterns", () => {
  const patterns = readFilterPatterns(readFileSync(workflowPath, "utf8"));

  assert.ok(
    patterns.length > 20,
    `only parsed ${patterns.length} filter patterns — the parser drifted from the workflow`,
  );

  const negated = patterns.filter((entry) => entry.pattern.startsWith("!"));
  assert.deepEqual(
    negated,
    [],
    `negated patterns make their whole rule match every file in the repo:\n${negated
      .map((entry) => `  ci.yml:${entry.line} ${entry.rule}: ${entry.pattern}`)
      .join("\n")}\nExclude a subtree with a separate rule instead.`,
  );
});

test("the desktop rule still scopes to desktop work", () => {
  const patterns = readFilterPatterns(readFileSync(workflowPath, "utf8"));
  const desktop = patterns.filter((entry) => entry.rule === "desktop");

  assert.ok(desktop.length > 0, "no `desktop` rule found in ci.yml");
  assert.ok(
    desktop.some((entry) => entry.pattern === "desktop/**"),
    "the `desktop` rule no longer matches desktop/**",
  );
  assert.ok(
    desktop.every((entry) => !entry.pattern.includes("*/**") || entry.pattern.startsWith("desktop/") || entry.pattern.startsWith("scripts/")),
    "the `desktop` rule gained a broad glob outside desktop/ and scripts/",
  );
});
