#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <main-ref> <develop-ref>" >&2
  exit 2
fi

main_ref=$1
develop_ref=$2

if [[ -n "$(git status --porcelain)" ]]; then
  echo "back-merge requires a clean worktree" >&2
  exit 2
fi

main_tree=$(git rev-parse "${main_ref}^{tree}")
develop_tree=$(git rev-parse "${develop_ref}^{tree}")

if [[ "$main_tree" == "$develop_tree" ]]; then
  echo "main and develop have identical trees; nothing to back-merge" >&2
  echo synchronized
  exit 0
fi

if git merge-base --is-ancestor "$main_ref" "$develop_ref"; then
  echo "develop already contains main; nothing to back-merge" >&2
  echo synchronized
  exit 0
fi

# Work detached so the caller can publish the prepared result only to its
# deterministic PR branch. The protected develop ref is never updated here.
git switch --detach "$develop_ref" >/dev/null
if git merge --no-edit "$main_ref" >&2; then
  echo clean
  exit 0
fi

git merge --abort
git switch --detach "$main_ref" >/dev/null
echo conflict
