#!/usr/bin/env bash
# Stage the Colony CLI release assets for one target.
#
# Produces four files in a staging directory, and exports STAGING to
# $GITHUB_ENV:
#   buzz-<version>-<target>.tar.gz(.sha256)  for the immutable cli-v<version>
#                                            release
#   buzz-<target>.tar.gz(.sha256)            for the rolling colony-cli-latest
#                                            release, which is the URL
#                                            scripts/install-cli.sh downloads
#
# The tarball is flat: `buzz` and `buzz-acp` sit at its root with no wrapping
# directory, so the install script can extract straight into a temp dir.
#
# A checksum file names the file it covers, so the two names need two of them
# rather than one copied twice.
set -euo pipefail

: "${BIN_DIR:?BIN_DIR is not set (the build step exports it)}"
: "${VERSION:?VERSION is not set}"
: "${TARGET:?TARGET is not set}"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

STAGING="$(mktemp -d)"
STAGE_BIN="${STAGING}/bin"
mkdir -p "$STAGE_BIN"

for bin in buzz buzz-acp; do
  src="${BIN_DIR}/${bin}"
  if [ ! -f "$src" ]; then
    echo "::error::Missing built binary ${src}" >&2
    exit 1
  fi
  # A 0-byte or tiny file here means the build step failed quietly. A tarball
  # of stubs installs cleanly and then cannot run anything.
  size=$(wc -c < "$src" | tr -d ' ')
  if [ "$size" -lt 500000 ]; then
    echo "::error::${src} is ${size} bytes, which is a stub rather than a real binary" >&2
    exit 1
  fi
  cp "$src" "${STAGE_BIN}/${bin}"
  chmod 755 "${STAGE_BIN}/${bin}"
done

VERSIONED="buzz-${VERSION}-${TARGET}.tar.gz"
ROLLING="buzz-${TARGET}.tar.gz"

tar -czf "${STAGING}/${VERSIONED}" -C "$STAGE_BIN" buzz buzz-acp
cp "${STAGING}/${VERSIONED}" "${STAGING}/${ROLLING}"

( cd "$STAGING" && sha256_of "$VERSIONED" > "${VERSIONED}.sha256" )
( cd "$STAGING" && sha256_of "$ROLLING" > "${ROLLING}.sha256" )

echo "STAGING=${STAGING}" >> "$GITHUB_ENV"
echo "Staged in ${STAGING}:"
ls -l "$STAGING"
cat "${STAGING}/${VERSIONED}.sha256"
