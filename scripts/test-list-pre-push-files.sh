#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
helper="$repo_root/scripts/list-pre-push-files.sh"
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
mkdir -p web crates/example
echo page > web/page.ts
echo rust > crates/example/lib.rs
git add web/page.ts crates/example/lib.rs
git commit --quiet -m feature

first_push_files=$("$helper" | sort)
expected_first=$(printf '%s\n' crates/example/lib.rs web/page.ts)
if [[ $first_push_files != "$expected_first" ]]; then
  echo "first-push file selection used the wrong diff:" >&2
  printf '%s\n' "$first_push_files" >&2
  exit 1
fi

git push --quiet -u origin feature
mkdir -p mobile
echo mobile > mobile/app.dart
git add mobile/app.dart
git commit --quiet -m follow-up

upstream_files=$("$helper")
if [[ $upstream_files != "mobile/app.dart" ]]; then
  echo "upstream file selection should include only unpushed work:" >&2
  printf '%s\n' "$upstream_files" >&2
  exit 1
fi

git switch --quiet -c no-upstream
echo another > web/another.ts
git add web/another.ts
git commit --quiet -m no-upstream
if COLONY_PRE_PUSH_BASE_REF=origin/missing "$helper" >/dev/null 2>&1; then
  echo "missing first-push base must fail closed" >&2
  exit 1
fi

echo "pre-push file selection contract passed"
