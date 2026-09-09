#!/usr/bin/env bash
# These jobs install Playwright's pinned Chromium, not Google Chrome. An
# inconsistent unused Chrome apt index must not block verified Ubuntu packages.
set -euo pipefail

if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux ||
      "${RUNNER_ENVIRONMENT:-}" != github-hosted ]]; then
  exit 0
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
sudo env GITHUB_ACTIONS=true RUNNER_OS=Linux RUNNER_ENVIRONMENT=github-hosted \
  python3 "$HERE/ci-prepare-apt-sources.py"
