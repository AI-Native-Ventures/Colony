#!/usr/bin/env bash
# Upload one target's Colony CLI assets to the public colony-releases repo.
#
# Every platform job runs this, so it publishes to two releases:
#   cli-v<version>     immutable, one per release, keeps the version in the
#                      asset filenames
#   colony-cli-latest  rolling, unversioned asset names. This is what
#                      scripts/install-cli.sh downloads, because
#                      /releases/latest/download in this repo points at
#                      whatever the desktop release published last.
#
# The platform jobs run concurrently and both may find a release missing at the
# same moment, so a create that loses the race is not an error as long as the
# release exists afterwards.
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is not set (the publisher token step exports it)}"
: "${STAGING:?STAGING is not set (the packaging step exports it)}"
: "${VERSION:?VERSION is not set}"
: "${TARGET:?TARGET is not set}"
: "${TAG:?TAG is not set}"
: "${RELEASE_REPO:?RELEASE_REPO is not set}"
: "${ROLLING_TAG:?ROLLING_TAG is not set}"

ensure_release() {
  tag=$1
  title=$2
  notes=$3
  if gh release view "$tag" --repo "$RELEASE_REPO" >/dev/null 2>&1; then
    return 0
  fi
  gh release create "$tag" --repo "$RELEASE_REPO" --title "$title" --notes-file "$notes" || true
  if ! gh release view "$tag" --repo "$RELEASE_REPO" >/dev/null 2>&1; then
    echo "::error::Could not create or find release ${tag} in ${RELEASE_REPO}" >&2
    exit 1
  fi
}

NOTES="${STAGING}/notes.md"
PREV="$(git describe --tags --abbrev=0 --match 'cli-v[0-9]*' "${TAG}^" 2>/dev/null || true)"
{
  echo "Colony CLI ${VERSION}: the \`buzz\` and \`buzz-acp\` binaries."
  echo
  echo "Install:"
  echo
  echo '```sh'
  echo "curl -fsSL https://colony.ainative.ventures/install.sh | sh"
  echo '```'
  echo
  if [ -n "$PREV" ]; then
    echo "Changes since ${PREV}:"
    git log --no-merges --pretty='- %s' "${PREV}..${TAG}" 2>/dev/null || true
  else
    echo "Recent changes:"
    git log --no-merges --pretty='- %s' -25 HEAD 2>/dev/null || true
  fi
} > "$NOTES"

ROLLING_NOTES="${STAGING}/rolling-notes.md"
{
  echo "The newest Colony CLI build for each platform, under stable filenames."
  echo
  echo "scripts/install-cli.sh downloads from this release, so these URLs never"
  echo "change. For a specific version, use the cli-v<version> release instead."
} > "$ROLLING_NOTES"

VERSIONED="buzz-${VERSION}-${TARGET}.tar.gz"
ROLLING="buzz-${TARGET}.tar.gz"

ensure_release "$TAG" "Colony CLI ${VERSION}" "$NOTES"
gh release upload "$TAG" --repo "$RELEASE_REPO" --clobber \
  "${STAGING}/${VERSIONED}" "${STAGING}/${VERSIONED}.sha256"

ensure_release "$ROLLING_TAG" "Colony CLI (latest)" "$ROLLING_NOTES"
gh release upload "$ROLLING_TAG" --repo "$RELEASE_REPO" --clobber \
  "${STAGING}/${ROLLING}" "${STAGING}/${ROLLING}.sha256"

echo "Published ${TARGET}:"
echo "  https://github.com/${RELEASE_REPO}/releases/download/${TAG}/${VERSIONED}"
echo "  https://github.com/${RELEASE_REPO}/releases/download/${ROLLING_TAG}/${ROLLING}"
