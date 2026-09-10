import assert from "node:assert/strict";
import test from "node:test";

import { buildWorktreeRequest, worktreeBranchFor } from "./worktreePlan.ts";

function project(overrides = {}) {
  return {
    dtag: "colony",
    primaryRepositoryAddress: "30617:owner:colony",
    repositories: [
      {
        repoAddress: "30617:owner:colony",
        cloneUrls: ["https://example.test/colony.git"],
        defaultBranch: "develop",
      },
    ],
    ...overrides,
  };
}

test("branch names are kebab-cased, prefixed and capped", () => {
  assert.equal(
    worktreeBranchFor("Add the Sales inbox", "Nova"),
    "feat/add-the-sales-inbox",
  );
  const long = worktreeBranchFor(
    "Rebuild the entire onboarding funnel end to end for every customer",
    "Nova",
  );
  assert.ok(long.length <= 40, long);
  assert.ok(long.startsWith("feat/"));
  assert.ok(!long.endsWith("-"), long);
});

test("a brief with no words falls back to the agent name", () => {
  assert.equal(worktreeBranchFor("!!! ???", "Nova Scout"), "feat/nova-scout");
  assert.equal(worktreeBranchFor("", "***"), "feat/agent");
});

test("accents and punctuation reduce to ascii words", () => {
  assert.equal(
    worktreeBranchFor("Café — déjà vu!", "Nova"),
    "feat/cafe-deja-vu",
  );
});

test("the request names the primary repository", () => {
  assert.deepEqual(
    buildWorktreeRequest({
      project: project(),
      reposDir: "/workspace/repos",
      branch: "feat/x",
    }),
    {
      reposDir: "/workspace/repos",
      projectDtag: "colony",
      cloneUrl: "https://example.test/colony.git",
      branch: "feat/x",
      from: "develop",
    },
  );
});

test("a project without a repository yields no request", () => {
  assert.equal(
    buildWorktreeRequest({
      project: project({ repositories: [] }),
      reposDir: "/workspace/repos",
      branch: "feat/x",
    }),
    null,
  );
  assert.equal(
    buildWorktreeRequest({
      project: null,
      reposDir: "/workspace/repos",
      branch: "feat/x",
    }),
    null,
  );
});
