#!/usr/bin/env bash
# Install Playwright's Linux system packages, surviving a stalled Ubuntu mirror.
#
# `playwright install-deps` shells out to apt-get, so it inherits the stall
# described in scripts/ci-apt-install.sh: on 2026-08-19 three smoke shards sat
# in this step for 43 minutes and were killed by the job timeout. A later run
# showed why a total timeout is the wrong bound here: four shards finished this
# step in 13s to 47s, one took 240s and still passed, and one was killed at
# 300s. Bound it on silence instead, via scripts/ci-run-until-idle.sh.
#
# Run from the directory holding the Playwright install (desktop/).
# Usage: scripts/ci-playwright-deps.sh [browser]
set -euo pipefail

BROWSER="${1:-chromium}"
ATTEMPTS="${CI_PLAYWRIGHT_DEPS_ATTEMPTS:-3}"
IDLE_LIMIT="${CI_PLAYWRIGHT_DEPS_IDLE_LIMIT:-120}"
RETRY_DELAY="${CI_PLAYWRIGHT_DEPS_RETRY_DELAY:-15}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if "$HERE/ci-run-until-idle.sh" "$IDLE_LIMIT" \
    pnpm exec playwright install-deps "$BROWSER"; then
    exit 0
  fi
  echo "::warning::playwright install-deps attempt ${attempt}/${ATTEMPTS} failed (idle limit ${IDLE_LIMIT}s)" >&2
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$RETRY_DELAY"
  fi
done

echo "playwright install-deps failed after ${ATTEMPTS} attempts" >&2
exit 1
