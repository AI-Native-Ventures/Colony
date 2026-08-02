#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

. ./bin/activate-hermit

export BUZZ_DISCOVERY_EXTERNAL_WORKER_ENABLED=true
export BUZZ_DISCOVERY_FAKE_EXECUTOR_ENABLED=false
export BUZZ_DISCOVERY_LEASE_SECONDS=5
export BUZZ_RELAY_PRIVATE_KEY=1111111111111111111111111111111111111111111111111111111111111111
export RELAY_URL=ws://localhost:3030
export DATABASE_URL=postgres://buzz:buzz_dev@localhost:5471/buzz

./scripts/start-isolated-test-relay.sh --profile dev

cargo test -p buzz-test-client --test e2e_discovery \
  local_worker_is_restart_safe_private_and_fenced -- --ignored --nocapture

cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  native_host_real_relay_completes_and_recovers_after_restart \
  -- --ignored --nocapture

echo "[discovery-worker] PASS: protocol fencing, native restart recovery, and privacy"
