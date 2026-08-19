#!/usr/bin/env bash
# Install Playwright's Linux system packages, surviving a stalled Ubuntu mirror.
#
# `playwright install-deps` shells out to apt-get, so it inherits the stall
# described in scripts/ci-apt-install.sh: on 2026-08-19 three smoke shards sat
# in this step for 43 minutes and were killed by the job timeout. Bound it with
# an external timeout and retry instead.
#
# Run from the directory holding the Playwright install (desktop/).
# Usage: scripts/ci-playwright-deps.sh [browser]
set -euo pipefail

BROWSER="${1:-chromium}"
ATTEMPTS="${CI_PLAYWRIGHT_DEPS_ATTEMPTS:-3}"
STEP_TIMEOUT="${CI_PLAYWRIGHT_DEPS_TIMEOUT:-300}"
RETRY_DELAY="${CI_PLAYWRIGHT_DEPS_RETRY_DELAY:-15}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if timeout --kill-after=30 "$STEP_TIMEOUT" \
    pnpm exec playwright install-deps "$BROWSER"; then
    exit 0
  fi
  echo "::warning::playwright install-deps attempt ${attempt}/${ATTEMPTS} failed (limit ${STEP_TIMEOUT}s)" >&2
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$RETRY_DELAY"
  fi
done

echo "playwright install-deps failed after ${ATTEMPTS} attempts" >&2
exit 1
