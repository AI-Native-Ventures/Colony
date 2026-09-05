#!/usr/bin/env bash
# Resolve the version a Colony CLI release publishes under, and export it plus
# the release tag to $GITHUB_ENV.
#
# Two entry paths, deliberately held to different standards:
#   tag push - the normal release. Held to the same rule the desktop release
#              uses: the run's ref, HEAD, and the tag must resolve to one
#              commit (scripts/verify-release-ref.sh).
#   dispatch - the manual path, used to cut the first release before a tag
#              exists. There is no tag to check, so only the version string is
#              validated. An empty input falls back to the workspace version in
#              the root Cargo.toml.
set -euo pipefail

workspace_version() {
  awk '
    /^\[workspace\.package\]/ { in_section = 1; next }
    /^\[/ { in_section = 0 }
    in_section && /^version[[:space:]]*=/ {
      gsub(/^version[[:space:]]*=[[:space:]]*"|"[[:space:]]*$/, "")
      print
      exit
    }
  ' Cargo.toml
}

case "${GITHUB_REF:-}" in
  refs/tags/cli-v*)
    VERSION="${GITHUB_REF_NAME#cli-v}"
    scripts/verify-release-ref.sh cli-v "$VERSION"
    ;;
  *)
    VERSION="${INPUT_VERSION:-}"
    if [ -z "$VERSION" ]; then
      VERSION="$(workspace_version)"
      echo "No version input given; using the workspace version ${VERSION}"
    fi
    if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
      echo "::error::Invalid release version '${VERSION}'" >&2
      exit 1
    fi
    ;;
esac

echo "VERSION=${VERSION}" >> "$GITHUB_ENV"
echo "TAG=cli-v${VERSION}" >> "$GITHUB_ENV"
echo "Releasing Colony CLI ${VERSION} as cli-v${VERSION}"
