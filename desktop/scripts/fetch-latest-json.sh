#!/usr/bin/env bash
set -euo pipefail

# Read the updater manifest currently published on the rolling release.
#
# This reads through the GitHub API rather than the public download URL on
# purpose. The release download CDN keeps serving the previous copy of an
# asset for minutes after it is overwritten, and that stale read caused two
# distinct failures on v0.10.9:
#
#   1. Both platform jobs failed their own "Verify the update manifest" step
#      on a release whose artifacts were completely correct - the job read
#      back the pre-upload manifest a second after uploading the new one.
#   2. The more dangerous one: the merge step reads the current manifest to
#      carry the other platform's entry over. Mac and Windows now build in
#      parallel from the same tag, so a stale read there makes the second job
#      to publish overwrite the first job's entry, and that platform's users
#      silently stop being offered the update.
#
# The API returns the asset bytes that were actually stored, with no CDN in
# front of it, so both callers see the truth immediately.
#
# Prints the manifest to stdout. Prints nothing when the release or the asset
# does not exist yet (the first release), which callers treat as "there is
# nothing to preserve".
#
# Requires gh to be authenticated with read access to <repo>.
#
# Usage: fetch-latest-json.sh <owner/repo> <rolling-tag> [asset-name]

if [[ $# -lt 2 ]]; then
  echo "Usage: fetch-latest-json.sh <owner/repo> <rolling-tag> [asset-name]" >&2
  exit 1
fi

REPO="$1"
TAG="$2"
ASSET="${3:-latest.json}"

# A missing rolling release is the first-release case, not an error.
#
# The id must be checked for being a number rather than merely non-empty: on a
# 404 gh prints its error body to STDOUT, so a missing release yields a blob of
# error JSON here, and passing that on as an id produces a confusing failure in
# the next call instead of the intended "nothing to preserve".
ASSET_ID=$(gh api "repos/${REPO}/releases/tags/${TAG}" \
  --jq ".assets[] | select(.name == \"${ASSET}\") | .id" 2>/dev/null || true)

if [[ ! "$ASSET_ID" =~ ^[0-9]+$ ]]; then
  exit 0
fi

gh api -H "Accept: application/octet-stream" \
  "repos/${REPO}/releases/assets/${ASSET_ID}"
