#!/usr/bin/env bash
# Pre-push guard: CI checks a PR merged with its target branch, so local runs
# on a skewed branch can pass while CI fails. The normal integration target is
# develop; release work targeting main must explicitly set
# COLONY_PRE_PUSH_BASE_REF=origin/main.
set -euo pipefail

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" = "main" ] || [ "$branch" = "HEAD" ]; then
  exit 0
fi

base_ref=${COLONY_PRE_PUSH_BASE_REF:-origin/develop}
base_remote=${base_ref%%/*}
base_branch=${base_ref#*/}

if [ "$base_remote" = "$base_ref" ] || [ -z "$base_branch" ]; then
  echo "COLONY_PRE_PUSH_BASE_REF must name a remote branch, such as origin/develop." >&2
  exit 1
fi

git fetch --quiet "$base_remote" "$base_branch" || true
git rev-parse --verify --quiet "$base_ref" >/dev/null || exit 0

base=$(git merge-base HEAD "$base_ref")
if [ "$base" = "$(git rev-parse "$base_ref")" ]; then
  exit 0
fi

overlap=$(comm -12 \
  <(git diff --name-only "$base" "$base_ref" -- | sort) \
  <(git diff --name-only "$base" HEAD -- | sort))

if [ -z "$overlap" ]; then
  exit 0
fi

{
  echo "Branch is behind $base_ref, and that target changed files this branch also touches:"
  echo "$overlap" | sed 's/^/  /'
  echo "Local checks ran on a tree CI will never test. Run 'git merge $base_ref',"
  echo "resolve, re-run checks, then push."
} >&2
exit 1
