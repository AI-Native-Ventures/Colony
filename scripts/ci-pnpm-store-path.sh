#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT must be set before resolving the pnpm store path}"

for attempt in 1 2 3; do
  if store_path="$(pnpm store path --silent)"; then
    if [[ -n "${store_path}" && "${store_path}" != *$'\n'* ]]; then
      printf 'STORE_PATH=%s\n' "${store_path}" >> "${GITHUB_OUTPUT}"
      exit 0
    fi
    echo "pnpm store path returned an empty or invalid path" >&2
  else
    status=$?
    echo "pnpm store path failed on attempt ${attempt}/3 (exit ${status})" >&2
  fi

  if [[ "${attempt}" -lt 3 ]]; then
    sleep $((attempt * 5))
  fi
done

echo "::error::Unable to resolve the pnpm store path after 3 attempts; the pinned pnpm archive may be unavailable." >&2
exit 1
