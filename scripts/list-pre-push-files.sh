#!/usr/bin/env bash
# Print the files a pre-push hook must validate. Lefthook's built-in first-push
# fallback compares HEAD with an empty tree, which makes a new branch look like
# a whole-repository change. Compare a new branch with its integration base
# instead, while retaining Lefthook's precise @{push} comparison afterwards.
set -euo pipefail

if git rev-parse --verify --quiet '@{push}' >/dev/null; then
  git diff --name-only '@{push}' HEAD --
  exit 0
fi

# Colony feature branches normally integrate through develop. Allow an explicit
# override for release tooling, but fail closed if the requested base is absent:
# silently skipping all validation is worse than asking a developer to fetch.
base_ref=${COLONY_PRE_PUSH_BASE_REF:-origin/develop}
if ! git rev-parse --verify --quiet "$base_ref" >/dev/null; then
  echo "Cannot determine pre-push diff: missing $base_ref. Fetch it or set COLONY_PRE_PUSH_BASE_REF." >&2
  exit 1
fi

base=$(git merge-base HEAD "$base_ref")
git diff --name-only "$base" HEAD --
