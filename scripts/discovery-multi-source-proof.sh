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

# Agent and desktop-worker identities use the same signed workspace/run
# protocol as the native UI. No provider credentials cross this boundary.
cargo test -p buzz-test-client --test e2e_discovery \
  generic_agent_and_desktop_worker_share_the_discovery_primitive \
  -- --ignored --nocapture

# Real local relay fencing: restart, cancellation, entitlement revocation,
# incompatible claims, lost leases, and private receipts.
cargo test -p buzz-test-client --test e2e_discovery \
  local_worker_is_restart_safe_private_and_fenced \
  -- --ignored --nocapture

# Deterministic provider/coordinator coverage. Provider clients use loopback
# HTTP servers or in-memory barriers, never paid Brave, Exa, or Outscraper APIs.
for test_filter in \
  discovery_worker::coordinator::tests \
  discovery_worker::brave::tests \
  discovery_worker::exa::tests \
  discovery_worker::outscraper::tests \
  discovery_worker::outbox::tests \
  discovery_worker::worker_host::tests
do
  cargo test --manifest-path desktop/src-tauri/Cargo.toml \
    "${test_filter}" -- --nocapture
done

# Cross-campaign dedupe and durable provider provenance use real Postgres.
DISCOVERY_PROOF_DB="buzz_discovery_proof_${PPID}_${RANDOM}"
case "${DISCOVERY_PROOF_DB}" in
  buzz_discovery_proof_[0-9]*) ;;
  *)
    echo "Refusing to manage an unexpected proof database name" >&2
    exit 1
    ;;
esac
cleanup_discovery_proof_db() {
  PGPASSWORD=buzz_dev dropdb --if-exists --force \
    --host localhost --port 5471 --username buzz "${DISCOVERY_PROOF_DB}"
}
trap cleanup_discovery_proof_db EXIT
PGPASSWORD=buzz_dev createdb \
  --host localhost --port 5471 --username buzz "${DISCOVERY_PROOF_DB}"
BUZZ_TEST_DATABASE_URL="postgres://buzz:buzz_dev@localhost:5471/${DISCOVERY_PROOF_DB}" \
  cargo test -p buzz-db \
  observation_batches_replay_and_deduplicate_across_campaigns \
  -- --ignored --nocapture --test-threads=1
cleanup_discovery_proof_db
trap - EXIT

# The native host proof calls only its loopback provider, drains its durable
# outbox after a forced restart, and commits through the real local relay.
cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  native_host_real_relay_completes_and_recovers_after_restart \
  -- --ignored --nocapture

echo "[discovery-multi-source] PASS: agent parity, source plans, fencing, recovery, dedupe, and privacy"
