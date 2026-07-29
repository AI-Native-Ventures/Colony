#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
verify="${repo_root}/scripts/verify-release-ref.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -q
git -C "$tmp" config user.name test
git -C "$tmp" config user.email test@example.com
echo first >"$tmp/file"
git -C "$tmp" add file
git -C "$tmp" commit -qm first
git -C "$tmp" tag -m "desktop release" desktop-v1.2.3

(
  cd "$tmp"
  GITHUB_REF=refs/tags/desktop-v1.2.3 "$verify" desktop-v 1.2.3
)

if (
  cd "$tmp"
  GITHUB_REF=refs/heads/main "$verify" desktop-v 1.2.3
); then
  echo "branch-backed desktop release was accepted" >&2
  exit 1
fi

echo second >>"$tmp/file"
git -C "$tmp" commit -qam second
if (
  cd "$tmp"
  GITHUB_REF=refs/tags/desktop-v1.2.3 "$verify" desktop-v 1.2.3
); then
  echo "release accepted HEAD after the tag commit" >&2
  exit 1
fi

git -C "$tmp" tag -m "relay release" relay-v2.0.0
(
  cd "$tmp"
  GITHUB_REF=refs/tags/relay-v2.0.0 "$verify" relay-v 2.0.0
)

if grep -q 'inputs\.ref' \
  "$repo_root/.github/workflows/release.yml" \
  "$repo_root/.github/workflows/docker.yml"; then
  echo "publisher workflow still accepts a caller-selected source ref" >&2
  exit 1
fi

grep -q 'verify-release-ref\.sh' "$repo_root/.github/workflows/release.yml"
grep -q 'verify-release-ref\.sh' "$repo_root/.github/workflows/docker.yml"
grep -q 'test-release-ref-contract\.sh' "$repo_root/.github/workflows/ci.yml"
"$repo_root/scripts/test-signed-canary-contract.sh"
auto_tag="$repo_root/.github/workflows/auto-tag-on-release-pr-merge.yml"
grep -q 'actions/create-github-app-token@' "$auto_tag"
grep -q 'client-id:.*vars\.BUZZ_RELEASE_TAGGER_CLIENT_ID' "$auto_tag"
grep -q 'private-key:.*secrets\.BUZZ_RELEASE_TAGGER_PRIVATE_KEY' "$auto_tag"
grep -q 'permission-contents: write' "$auto_tag"
grep -q 'GH_TOKEN:.*steps\.release-tagger\.outputs\.token' "$auto_tag"
grep -Fq 'git/refs' "$auto_tag"
grep -Fq 'TAG_PREFIX="desktop-v"' "$auto_tag"
grep -Fq 'target_sha=${{ github.event.pull_request.head.sha }}' "$auto_tag"
grep -Fq 'scripts/verify-desktop-release-merge.sh' "$auto_tag"
release_workflow="$repo_root/.github/workflows/release.yml"
[[ "$(grep -c 'contents: write' "$release_workflow")" -eq 1 ]] || {
  echo "desktop release must have exactly one GitHub contents writer" >&2; exit 1;
}
grep -Fq "needs.release.result == 'success'" "$release_workflow"
grep -Fq "needs.release-macos-x64.result == 'success'" "$release_workflow"
grep -Fq "needs.release-linux.result == 'success'" "$release_workflow"
grep -Fq "needs.release-windows.result == 'success'" "$release_workflow"
grep -Fq "refs/tags/desktop-v{0}" "$release_workflow"
grep -Fq "if: \${{ env.already_published != 'true' && !contains(needs.setup.outputs.version, '-') }}" "$release_workflow"
grep -Fq 'group: desktop-release-${{ github.ref }}' "$release_workflow"
grep -Fq 'cancel-in-progress: false' "$release_workflow"
grep -Fq 'release artifact basename collision' "$release_workflow"
[[ "$(grep -c 'gh release upload' "$release_workflow")" -eq 2 ]] || {
  echo "only the final writer may upload versioned and rolling release assets" >&2; exit 1;
}
grep -Fq 'if: env.already_published' "$release_workflow"
grep -Fq 'if gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG" --silent 2>/dev/null; then' "$auto_tag"
if grep -F 'git/ref/tags/$TAG' "$auto_tag" | grep -Fq '|| true'; then
  echo "auto-tag ignores a failed tag lookup, so a 404 body can look like an existing tag" >&2
  exit 1
fi
if grep -q 'gh workflow run' "$auto_tag"; then
  echo "auto-tag still dispatches a publisher instead of using the tag push" >&2
  exit 1
fi

echo "release ref contract passed"
