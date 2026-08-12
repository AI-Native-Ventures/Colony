#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
helper="$repo_root/scripts/backmerge-main-to-develop.sh"
workflow="$repo_root/.github/workflows/backmerge-main-to-develop.yml"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
  echo "back-merge contract failed: $*" >&2
  exit 1
}

[[ -x "$helper" ]] || fail "missing executable classifier helper"

if grep -Eq 'git push[^\n]*(HEAD:develop|origin develop)' "$workflow"; then
  fail "workflow still pushes directly to develop"
fi
if grep -Eq 'git push[^\n]*--force(-with-lease)?' "$workflow"; then
  fail "workflow still force-updates a remote branch"
fi

grep -q 'gh pr list' "$workflow" || fail "workflow does not reuse an open PR"
grep -q 'gh pr create' "$workflow" || fail "workflow does not create a PR"
grep -Eq 'gh pr merge .*--merge --auto' "$workflow" ||
  fail "clean back-merge is not armed for the protected merge queue"
grep -q 'BACKMERGE_MAINTAINER_TOKEN' "$workflow" ||
  fail "workflow does not use the maintainer PR identity"
grep -Fq 'if [[ "$STATUS" == clean ]]' "$workflow" ||
  fail "auto-merge is not restricted to clean drift"

pr_list_line=$(grep -n 'gh pr list' "$workflow" | head -1 | cut -d: -f1)
push_line=$(grep -n 'git push origin "HEAD:refs/heads/\$BRANCH"' "$workflow" |
  head -1 | cut -d: -f1)
[[ -n "$pr_list_line" && -n "$push_line" && "$pr_list_line" -lt "$push_line" ]] ||
  fail "workflow does not check for an open PR before publishing its branch"

new_repo() {
  local dir=$1
  git -C "$dir" init -q
  git -C "$dir" config user.name "backmerge contract"
  git -C "$dir" config user.email "backmerge-contract@example.com"
  echo base >"$dir/shared.txt"
  git -C "$dir" add shared.txt
  git -C "$dir" commit -qm base
  git -C "$dir" branch -M main
}

assert_clean() {
  local dir=$1
  [[ -z "$(git -C "$dir" status --porcelain)" ]] ||
    fail "helper left a dirty worktree in $dir"
}

# Identical trees with deliberately divergent commit histories are already
# synchronized. This is the production promotion shape that broke the old
# ancestry-only workflow.
identical="$tmp/identical"
mkdir "$identical"
new_repo "$identical"
git -C "$identical" switch -qc develop
echo same >"$identical/shared.txt"
git -C "$identical" commit -qam "develop shape"
develop_before=$(git -C "$identical" rev-parse HEAD)
git -C "$identical" switch -q main
echo same >"$identical/shared.txt"
git -C "$identical" commit -qam "main shape"
git -C "$identical" switch -q develop
status=$(cd "$identical" && "$helper" main develop)
[[ "$status" == synchronized ]] || fail "identical trees classified as $status"
[[ "$(git -C "$identical" rev-parse HEAD)" == "$develop_before" ]] ||
  fail "identical-tree no-op moved HEAD"
assert_clean "$identical"

# main already contained in develop is also a no-op.
ancestor="$tmp/ancestor"
mkdir "$ancestor"
new_repo "$ancestor"
git -C "$ancestor" switch -qc develop
echo develop >"$ancestor/develop.txt"
git -C "$ancestor" add develop.txt
git -C "$ancestor" commit -qm develop
status=$(cd "$ancestor" && "$helper" main develop)
[[ "$status" == synchronized ]] || fail "ancestor case classified as $status"
assert_clean "$ancestor"

# Independent, non-conflicting changes prepare a merge commit for a PR.
clean="$tmp/clean"
mkdir "$clean"
new_repo "$clean"
git -C "$clean" switch -qc develop
echo develop >"$clean/develop.txt"
git -C "$clean" add develop.txt
git -C "$clean" commit -qm develop
develop_tip=$(git -C "$clean" rev-parse HEAD)
git -C "$clean" switch -q main
echo main >"$clean/main.txt"
git -C "$clean" add main.txt
git -C "$clean" commit -qm main
main_tip=$(git -C "$clean" rev-parse HEAD)
git -C "$clean" switch -q develop
status=$(cd "$clean" && "$helper" main develop)
[[ "$status" == clean ]] || fail "clean drift classified as $status"
git -C "$clean" merge-base --is-ancestor "$develop_tip" HEAD ||
  fail "clean result does not contain develop"
git -C "$clean" merge-base --is-ancestor "$main_tip" HEAD ||
  fail "clean result does not contain main"
assert_clean "$clean"

# Conflicting changes publish main itself for a human-resolved PR and leave no
# half-finished merge state behind.
conflict="$tmp/conflict"
mkdir "$conflict"
new_repo "$conflict"
git -C "$conflict" switch -qc develop
echo develop >"$conflict/shared.txt"
git -C "$conflict" commit -qam develop
git -C "$conflict" switch -q main
echo main >"$conflict/shared.txt"
git -C "$conflict" commit -qam main
main_tip=$(git -C "$conflict" rev-parse HEAD)
git -C "$conflict" switch -q develop
status=$(cd "$conflict" && "$helper" main develop)
[[ "$status" == conflict ]] || fail "conflicting drift classified as $status"
[[ "$(git -C "$conflict" rev-parse HEAD)" == "$main_tip" ]] ||
  fail "conflict result is not rooted at main"
assert_clean "$conflict"

echo "back-merge contract passed"
