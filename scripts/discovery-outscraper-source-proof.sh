#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

. ./bin/activate-hermit

PROOF_OUTPUT="$(mktemp -t colony-discovery-source-proof.XXXXXX)"
trap 'rm -f "${PROOF_OUTPUT}"' EXIT

cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  discovery_worker::outscraper::tests --lib -- --nocapture 2>&1 | tee "${PROOF_OUTPUT}"

./scripts/discovery-worker-live-proof.sh 2>&1 | tee -a "${PROOF_OUTPUT}"

if rg -q \
  'native-host-secret-never-crosses-relay|provider detail must not escape|temporary provider detail must not escape' \
  "${PROOF_OUTPUT}"; then
  echo "[discovery-outscraper] FAIL: sensitive fixture material reached process output" >&2
  exit 1
fi

echo "[discovery-outscraper] PASS: request idempotency, restart recovery, normalized persistence, returned usage, privacy, cancellation, entitlement fencing, bounded retry, and failure classification"
echo "[discovery-outscraper] No real Outscraper endpoint was contacted and no paid request was made."
