// Tests for scripts/instance-env.sh worktree detection.
//
// The bug this pins: every desktop dev command sources instance-env.sh from
// `desktop/`, not the repo root. From a subdirectory git answers --git-dir and
// --git-common-dir in different formats for the SAME directory (absolute vs
// `../.git`), so a string compare declared the main checkout a worktree and
// gave the app a per-branch identifier. Each branch switch then produced a
// fresh, empty app profile and agents lost their configuration.
//
// BUZZ_INSTANCE_SLUG is the observable: the script exports it only on the
// worktree path, and it does so before the swift icon step, so these tests need
// no icon toolchain.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "instance-env.sh");

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** A throwaway repo with one commit and a `desktop/` subdirectory. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "instance-env-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  writeFileSync(join(root, "README"), "x\n");
  git(root, "add", "README");
  git(root, "commit", "-qm", "init");
  mkdirSync(join(root, "desktop"));
  return root;
}

/** Source the script from `cwd` and report what it exported. */
function sourceFrom(cwd) {
  const out = execFileSync(
    "bash",
    [
      "-c",
      `set +e; . "${SCRIPT}" >/dev/null 2>&1; ` +
        `printf '%s\\n%s\\n' "\${BUZZ_INSTANCE_SLUG:-}" "$BUZZ_TAURI_CONFIG"`,
    ],
    { cwd, encoding: "utf8" },
  );
  const [slug, ...rest] = out.split("\n");
  return { slug, identifier: JSON.parse(rest.join("\n")).identifier };
}

test("main checkout is not treated as a worktree, from the repo root", () => {
  const root = makeRepo();
  try {
    const { slug, identifier } = sourceFrom(root);
    assert.equal(slug, "", "the main checkout must not get an instance slug");
    assert.equal(identifier, "xyz.block.buzz.app.dev");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("main checkout is not treated as a worktree, from desktop/", () => {
  // The regression. Desktop dev commands `cd desktop` before sourcing, and
  // from there git reports the same directory two different ways.
  const root = makeRepo();
  try {
    const { slug, identifier } = sourceFrom(join(root, "desktop"));
    assert.equal(
      slug,
      "",
      "sourcing from a subdirectory must not make the main checkout look like a worktree",
    );
    assert.equal(
      identifier,
      "xyz.block.buzz.app.dev",
      "a per-branch identifier here gives every branch its own empty app profile",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a real worktree still gets its own per-branch identity", () => {
  const root = makeRepo();
  const wt = `${root}-wt`;
  try {
    git(root, "worktree", "add", "-q", "-b", "feat/my-thing", wt);
    mkdirSync(join(wt, "desktop"), { recursive: true });
    for (const cwd of [wt, join(wt, "desktop")]) {
      const { slug } = sourceFrom(cwd);
      assert.equal(
        slug,
        "feat-my-thing",
        `a worktree must still be detected (cwd: ${cwd})`,
      );
    }
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
