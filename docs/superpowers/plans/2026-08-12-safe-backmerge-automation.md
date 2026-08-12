# Safe back-merge automation implementation plan

**Goal:** Replace the protected-branch direct push with deterministic,
testable PR automation while treating identical trees as synchronized.

**Architecture:** A shell helper classifies and prepares local git state; the
GitHub Actions workflow performs idempotent feature-branch and PR operations.
The normal Colony CI and develop merge queue remain the only path into
`develop`.

---

## Task 1: Establish the failing contract

**Files:**

- Create: `scripts/test-backmerge-main-to-develop.sh`
- Modify: `.github/workflows/ci.yml`

1. Add temporary-repository fixtures for identical divergent trees, ancestry,
   clean drift, and conflicts.
2. Add static workflow assertions forbidding direct or force pushes and
   requiring PR creation plus clean-only auto-merge.
3. Run the contract against the current workflow and record the expected red
   failure.
4. Invoke the contract from the unconditional `Detect Changed Paths` job so it
   is enforced by PR and merge-queue CI.

## Task 2: Implement the safe classifier and workflow

**Files:**

- Create: `scripts/backmerge-main-to-develop.sh`
- Modify: `.github/workflows/backmerge-main-to-develop.yml`

1. Compare tree object IDs before ancestry.
2. Return `synchronized` for identical trees or when `main` is already in
   `develop`.
3. Prepare a merge commit and return `clean` when the merge succeeds.
4. Abort the merge, reset to `main`, and return `conflict` when it does not.
5. In the workflow, reuse an open PR before inspecting or publishing its
   deterministic branch.
6. Reject an orphaned remote branch, push new branches without force, and
   create the clean or conflict PR with the maintainer token.
7. Arm `gh pr merge --merge --auto` only for the clean PR; make conflict runs
   report failure after the PR exists.

## Task 3: Local proof and review

1. Run the focused contract and shell syntax checks.
2. Run `just ci` as the repository pre-PR gate.
3. Inspect the staged diff for secret handling, branch targets, and destructive
   git operations.
4. Commit with DCO sign-off.

## Task 4: Protected develop delivery

1. Store the configured maintainer credential as the repository-only
   `BACKMERGE_MAINTAINER_TOKEN` Actions secret without printing it.
2. Push the feature branch and open a PR targeting `develop`.
3. Arm auto-merge, wait for PR CI, then verify merge-group CI and the merged
   `develop` SHA.

## Task 5: Production workflow promotion and live proof

1. Open the standard `develop`-to-`main` promotion PR.
2. Require every non-skipped check and the Promotion Gate to pass.
3. Merge through the protected `main` path.
4. Inspect the triggered back-merge run and prove its terminal status and
   effects: successful no-op with no branch/PR for identical trees, or the
   expected protected PR behavior for genuine drift.

