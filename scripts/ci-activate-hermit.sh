#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_ENV:?GITHUB_ENV must be set before activating Hermit}"

for attempt in 1 2 3; do
  output_file="$(mktemp)"
  if ./bin/hermit env --raw >"${output_file}"; then
    cat "${output_file}" >> "${GITHUB_ENV}"
    rm -f "${output_file}"
    exit 0
  fi
  rm -f "${output_file}"

  if [[ "${attempt}" -lt 3 ]]; then
    echo "Hermit environment activation failed (attempt ${attempt}/3), retrying..." >&2
    sleep $((attempt * 5))
  fi
done

echo "::error::Unable to activate Hermit after 3 attempts" >&2
exit 1
