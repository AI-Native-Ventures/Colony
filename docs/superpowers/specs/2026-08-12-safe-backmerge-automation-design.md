# Safe main-to-develop back-merge automation

## Problem

The current back-merge workflow treats ancestry as the only synchronization
signal. A production promotion creates different commit histories on `main`
and `develop` even when both tips have the same tree. The workflow therefore
creates a merge commit and tries to push it directly to protected `develop`.
The push is correctly rejected by the PR, required-check, and merge-queue
rules, so the control reports failure after every otherwise-correct promotion.

## Safety contract

The automation must classify the branch pair before it writes anything:

1. If the `main` and `develop` tree object IDs are identical, the branches are
   synchronized. Exit successfully without a branch, commit, push, or PR.
2. If `main` is already an ancestor of `develop`, the branches are
   synchronized. Exit successfully without a write.
3. If merging `main` into `develop` is clean, publish the merge commit on a
   deterministic feature branch, create or reuse a PR targeting `develop`, and
   arm merge-queue auto-merge. Never push directly to `develop`.
4. If the merge conflicts, publish a deterministic branch rooted at `main`,
   create or reuse a PR targeting `develop`, do not arm auto-merge, and fail the
   workflow loudly so the unresolved drift remains visible.

The workflow must look for an existing open PR before creating or updating a
remote branch. It must never force-push. An existing remote branch without the
expected open PR is an ambiguous state and must fail closed rather than be
overwritten.

## Authentication

The built-in `GITHUB_TOKEN` can push an unprotected feature branch, but GitHub
places CI for a PR created by that token into an approval-required state. The
configured `colony-release-tagger` App currently has `contents: write` only and
cannot create pull requests. The back-merge workflow will therefore use a
repository secret containing the already-configured maintainer identity only
for PR creation/reuse and merge-queue enrollment. The token is not used to
push either protected branch.

## Implementation shape

`scripts/backmerge-main-to-develop.sh` owns classification and local merge
preparation. It emits one status: `synchronized`, `clean`, or `conflict`.
Keeping git state transitions in a shell helper lets a temporary-repository
contract prove all three cases without GitHub mutations.

The workflow owns remote idempotency and GitHub operations. It derives the
feature branch from the exact `main` SHA, checks for an existing PR first,
rejects orphaned remote branches, pushes a new branch without force, creates
the appropriate PR, and arms auto-merge only for a clean merge.

## Proof gates

- Red: focused contract fails against the old ancestry-only/direct-push
  workflow.
- Green: temporary git histories prove identical-tree no-op, ancestor no-op,
  clean merge preparation, and conflict classification; static assertions
  prove no direct/force push and correct PR/auto-merge behavior.
- PR: normal `develop` CI passes on the PR head.
- Queue: merge-group CI passes and the PR lands through the protected queue.
- Promotion: a `develop`-to-`main` PR passes the full Promotion Gate and lands.
- Live automation: the resulting `main` push starts the updated workflow and
  it succeeds as an identical-tree no-op (or, if real drift exists, produces
  the correctly queued/non-auto-merged PR for its classification).
