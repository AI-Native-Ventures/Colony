#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
helper="$repo_root/scripts/check-branch-skew.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git init --bare "$tmp/origin.git" >/dev/null
git clone --quiet "$tmp/origin.git" "$tmp/work"
cd "$tmp/work"
git config user.name "CI contract"
git config user.email "ci-contract@example.test"

echo base > README.md
git add README.md
git commit --quiet -m base
git branch -M develop
git push --quiet -u origin develop

git switch --quiet -c feature
echo feature > feature.txt
git add feature.txt
git commit --quiet -m feature

# A develop-targeted branch must not be blocked just because a separate main
# branch is stale or absent.
"$helper"

git switch --quiet develop
echo target-change > feature.txt
git add feature.txt
git commit --quiet -m target-change
git push --quiet origin develop

git switch --quiet feature
if "$helper" >/dev/null 2>&1; then
  echo "overlapping target changes must block the push" >&2
  exit 1
fi

echo "branch-skew target contract passed"
