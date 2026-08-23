#!/usr/bin/env bash
# Download Hermit-managed binaries up front, with retries.
#
# Hermit stubs under bin/ fetch their real binary on first invocation, so a
# transient GitHub Releases error (504s are the common one) surfaces as a
# failure of whatever command happened to trigger the download rather than as
# a download failure. That is how a pgschema fetch flake failed a Desktop E2E
# Integration shard on 2026-08-21. Pre-warming here isolates the fetch: the
# retry covers the network, and the command that follows only runs real work.
#
# The trigger is the stub itself, invoked with --help. Do NOT reach for
# `hermit install <pkg>`: with no version it resolves to the latest release and
# repoints the stub, silently unpinning the tool.
#
# Usage: ./scripts/ci-prefetch-hermit-pkg.sh pgschema [more-pkgs...]
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "::error::ci-prefetch-hermit-pkg.sh needs at least one package name" >&2
  exit 1
fi

for pkg in "$@"; do
  stub="./bin/${pkg}"
  if [[ ! -x "${stub}" ]]; then
    echo "::error::${stub} is missing or not executable" >&2
    exit 1
  fi

  fetched=false
  for attempt in 1 2 3; do
    # --help does no work of its own, and every tool here accepts it. A
    # download failure exits non-zero before the binary ever runs.
    if "${stub}" --help >/dev/null 2>&1; then
      fetched=true
      break
    fi

    if [[ "${attempt}" -lt 3 ]]; then
      echo "Fetching ${pkg} failed (attempt ${attempt}/3), retrying..." >&2
      sleep $((attempt * 5))
    fi
  done

  if [[ "${fetched}" != true ]]; then
    echo "::error::Unable to download ${pkg} via Hermit after 3 attempts" >&2
    exit 1
  fi

  echo "${pkg} ready"
done
