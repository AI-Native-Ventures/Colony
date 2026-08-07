#!/usr/bin/env bash
# =============================================================================
# start-isolated-test-relay.sh — GUI read-model overhaul test harness (Dawn)
# =============================================================================
# Stands up a FULLY ISOLATED relay for seeding + parity/perf runs, from source
# on the current branch. Never touches the shared :3000 team relay or the
# default `buzz-*` dev stack. Backing services run under the dedicated
# `buzz-harness` Compose project (docker-compose.harness.yml); the relay runs
# in the foreground on override ports.
#
#   Topology (reuse this exact tuple for desktop parity runs):
#     compose project : buzz-harness        (or buzz-harness-<relay> when overridden)
#     postgres        : localhost:5471  (db=buzz, user=buzz, pass=buzz_dev)
#     redis           : localhost:6471
#     minio           : localhost:9471 (console 9472)
#     relay main      : localhost:3030   ← BUZZ_E2E_RELAY_URL=http://localhost:3030
#     relay health    : localhost:8088
#     relay metrics   : localhost:9202
#
# Every port resolves from the BUZZ_HARNESS_*_PORT overrides in
# scripts/harness-ports.sh; the defaults above are the historical fixed tuple,
# so plain runs and every existing doc keep working unchanged. Run a second
# harness concurrently on a disjoint set, e.g.:
#
#   export BUZZ_HARNESS_RELAY_PORT=3040  BUZZ_HARNESS_PG_PORT=5481
#   export BUZZ_HARNESS_REDIS_PORT=6481  BUZZ_HARNESS_MINIO_PORT=9481
#   export BUZZ_HARNESS_HEALTH_PORT=8098 BUZZ_HARNESS_METRICS_PORT=9212
#
# The Compose project name follows the relay port, so the second harness gets
# its own containers, volumes, and database. The pre-flight guard below fails
# BEFORE any mutation (compose up / schema reset / seed) when the port set is
# already owned by another process.
#
# Usage:
#   ./scripts/start-isolated-test-relay.sh [--profile <cargo-profile>]
#
# Teardown (safe — scoped to our project only):
#   docker compose -p "${HARNESS_PROJECT}" -f docker-compose.harness.yml down -v
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# shellcheck source=scripts/harness-ports.sh
source "${SCRIPT_DIR}/harness-ports.sh"

CARGO_PROFILE="${CARGO_PROFILE:-ci}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) CARGO_PROFILE="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Cargo names the development profile `dev`, but writes its binaries under
# target/debug. Accept `debug` as the user-facing spelling too.
case "${CARGO_PROFILE}" in
  dev|debug)
    CARGO_BUILD_PROFILE="dev"
    CARGO_TARGET_PROFILE="debug"
    ;;
  *)
    CARGO_BUILD_PROFILE="${CARGO_PROFILE}"
    CARGO_TARGET_PROFILE="${CARGO_PROFILE}"
    ;;
esac

PROJECT="${HARNESS_PROJECT}"
COMPOSE_FILE="docker-compose.harness.yml"

# Isolated ports (distinct from :3000 team relay, default dev stack, and Eva's
# evaperf :5470/:6470/:9470/:3170 stack). Resolved from BUZZ_HARNESS_*_PORT.
PG_PORT="${HARNESS_PG_PORT}"
REDIS_PORT="${HARNESS_REDIS_PORT}"
MINIO_PORT="${HARNESS_MINIO_PORT}"
MINIO_CONSOLE_PORT="${HARNESS_MINIO_CONSOLE_PORT}"
RELAY_MAIN="${HARNESS_RELAY_PORT}"
RELAY_HEALTH="${HARNESS_HEALTH_PORT}"
RELAY_METRICS="${HARNESS_METRICS_PORT}"
COMMUNITY_HOST="localhost:${RELAY_MAIN}"
DISCOVERY_EXTERNAL_WORKER_ENABLED="${BUZZ_DISCOVERY_EXTERNAL_WORKER_ENABLED:-false}"
DISCOVERY_FAKE_EXECUTOR_ENABLED="${BUZZ_DISCOVERY_FAKE_EXECUTOR_ENABLED:-false}"
DISCOVERY_LEASE_SECONDS="${BUZZ_DISCOVERY_LEASE_SECONDS:-30}"
RELAY_PRIVATE_KEY="${BUZZ_RELAY_PRIVATE_KEY:-}"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'
log() { echo -e "${BLUE}[isolated-relay]${NC} $*"; }
ok()  { echo -e "${GREEN}[isolated-relay]${NC} $*"; }
err() { echo -e "${RED}[isolated-relay]${NC} $*" >&2; }

# ── Pre-flight guard: fail BEFORE any mutation ────────────────────────────────
# This check must run before `docker compose up`, before the schema reset, and
# before the seed. The original script performed all of those first and only
# then refused on a busy port — by which point a second agent's shared
# Postgres had already been wiped. The only thing mutated here is our own
# previous tmux session, which is scoped to this port set and owns only our
# own previous relay; anything still listening afterwards belongs to someone
# else and the script stops before touching a single row.
RELAY_LOG="${RELAY_LOG:-/tmp/dawn-relay-${RELAY_MAIN}.log}"
TMUX_SESSION="${TMUX_SESSION:-dawn-relay-${RELAY_MAIN}}"
tmux kill-session -t "${TMUX_SESSION}" 2>/dev/null || true

port_in_use() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
port_override_hint() {
  cat >&2 <<HINT_EOF
To run this harness on a disjoint port set (example: +10 on every port):

  export BUZZ_HARNESS_RELAY_PORT=3040  BUZZ_HARNESS_PG_PORT=5481
  export BUZZ_HARNESS_REDIS_PORT=6481  BUZZ_HARNESS_MINIO_PORT=9481
  export BUZZ_HARNESS_HEALTH_PORT=8098 BUZZ_HARNESS_METRICS_PORT=9212
  ${REPO_ROOT}/scripts/prove-blocks.sh   # or start-isolated-test-relay.sh

Every port of the set must be disjoint from any running harness. This run
would use Compose project '${PROJECT}'; the project name derives from the relay
port, so a second harness gets its own containers, volumes, and database
automatically.
HINT_EOF
}

# A relay already listening on our main port means another agent owns this
# port set (or an orphaned relay is squatting on it). Always abort.
if command -v lsof >/dev/null 2>&1 && port_in_use "${RELAY_MAIN}"; then
  err "Port ${RELAY_MAIN} is already in use; refusing to report a stale relay as this harness."
  lsof -nP -iTCP:"${RELAY_MAIN}" -sTCP:LISTEN >&2 || true
  port_override_hint
  exit 1
fi

# Backing-service ports may legitimately be bound by OUR OWN previous run of
# this port set (the reuse path: containers stay up, schema is re-applied).
# A bound port while our project's postgres is NOT running is someone else's.
OUR_HARNESS_UP=false
if docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" ps --status running -q postgres 2>/dev/null | grep -q .; then
  OUR_HARNESS_UP=true
fi
if [[ "${OUR_HARNESS_UP}" == true ]]; then
  # A running project on this port set must be OUR OWN previous run: the
  # postgres container carries an owner label with the worktree that brought
  # it up. A mismatched owner means another agent's harness is up with its
  # relay temporarily down — the one case the port checks above cannot see.
  # Ownership precedence, most deliberate first:
  #   1. dev.buzz.harness.owner label — set by our own launcher since the
  #      marker shipped (see docker-compose.harness.yml).
  #   2. com.docker.compose.project.working_dir — compose metadata on
  #      containers created BEFORE the marker existed. It is the worktree
  #      path of whoever created the stack, so it identifies the owner
  #      without a label. Prefer it over config_files: it is already the
  #      path (no dirname), and it stays a single value even with multiple
  #      -f files, where config_files would become a list.
  #   3. com.docker.compose.project.config_files (dirname'd) — last resort
  #      for stacks carrying no working_dir.
  # Only when none of these exist do we treat the stack as unknown and
  # proceed, matching the pre-marker behavior.
  pg_container="$(docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" ps --status running -q postgres 2>/dev/null | head -1)"
  owner="$(docker inspect --format '{{if .Config.Labels}}{{if index .Config.Labels "dev.buzz.harness.owner"}}{{index .Config.Labels "dev.buzz.harness.owner"}}{{end}}{{end}}' "${pg_container}" 2>/dev/null || true)"
  if [[ -z "${owner}" ]]; then
    owner="$(docker inspect --format '{{if .Config.Labels}}{{index .Config.Labels "com.docker.compose.project.working_dir"}}{{end}}' "${pg_container}" 2>/dev/null || true)"
  fi
  if [[ -z "${owner}" ]]; then
    config_files="$(docker inspect --format '{{if .Config.Labels}}{{index .Config.Labels "com.docker.compose.project.config_files"}}{{end}}' "${pg_container}" 2>/dev/null || true)"
    if [[ -n "${config_files}" ]]; then
      owner="$(dirname "${config_files}")"
    fi
  fi
  if [[ -n "${owner}" && "${owner}" != "${REPO_ROOT}" ]]; then
    err "Compose project ${PROJECT} is already running and owned by ${owner}; refusing to reset its database."
    port_override_hint
    exit 1
  fi
fi
if [[ "${OUR_HARNESS_UP}" != true ]]; then
  for port in "${PG_PORT}" "${REDIS_PORT}" "${MINIO_PORT}" "${RELAY_HEALTH}" "${RELAY_METRICS}"; do
    if command -v lsof >/dev/null 2>&1 && port_in_use "${port}"; then
      err "Port ${port} is already in use by another process; refusing to start a harness that would collide with it."
      lsof -nP -iTCP:"${port}" -sTCP:LISTEN >&2 || true
      port_override_hint
      exit 1
    fi
  done
fi
ok "Port set is free (main :${RELAY_MAIN}, pg :${PG_PORT}, redis :${REDIS_PORT}, minio :${MINIO_PORT}, health :${RELAY_HEALTH}, metrics :${RELAY_METRICS})"

# ── Backing services (scoped to our project only) ───────────────────────────
log "Bringing up backing services (project=${PROJECT})..."
# Normalize the operator-facing overrides to the resolved values so the
# Compose file interpolates this port set even when only some were exported.
export BUZZ_HARNESS_PG_PORT="${HARNESS_PG_PORT}"
export BUZZ_HARNESS_REDIS_PORT="${HARNESS_REDIS_PORT}"
export BUZZ_HARNESS_MINIO_PORT="${HARNESS_MINIO_PORT}"
export BUZZ_HARNESS_MINIO_CONSOLE_PORT="${HARNESS_MINIO_CONSOLE_PORT}"
export BUZZ_HARNESS_OWNER="${REPO_ROOT}"
docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" up -d

wait_pg() {
  for _ in $(seq 1 60); do
    if docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" exec -T postgres \
         pg_isready -U buzz >/dev/null 2>&1; then
      ok "Postgres ready"; return 0
    fi
    sleep 2
  done
  err "Postgres did not become ready"; return 1
}
wait_pg

# ── Schema + partitions ──────────────────────────────────────────────────────
export PGPASSWORD=buzz_dev
psql_h() { docker compose -p "${PROJECT}" -f "${COMPOSE_FILE}" exec -T postgres \
  psql -U buzz -d buzz -v ON_ERROR_STOP=1 "$@"; }

log "Resetting isolated database and applying schema..."
# This database belongs only to our Compose project (unique per port set).
# Reset it on every launch so stale partitions/events from an earlier proof
# cannot alter schema planning or test results.
psql_h -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
export PGSCHEMA_PLAN_HOST=localhost PGSCHEMA_PLAN_PORT=${PG_PORT}
export PGSCHEMA_PLAN_DB=buzz PGSCHEMA_PLAN_USER=buzz PGSCHEMA_PLAN_PASSWORD=buzz_dev
export PGHOST=localhost PGPORT=${PG_PORT} PGUSER=buzz PGDATABASE=buzz
./bin/pgschema apply --file schema/schema.sql --auto-approve
psql_h < scripts/attach-schema-partitions.sql
ok "Schema applied"

# ── Deployment community + channels + members ────────────────────────────────
# setup-desktop-test-data.sh is the single writer of the dev community row and
# the channel/member seed. It keys everything off a fixed COMMUNITY_ID and an
# overridable host — point that host at OUR relay so the tenant binding matches,
# and point its DB env at OUR isolated postgres. (psql is on PATH, so it uses
# BUZZ_DB_HOST/PORT rather than the shared `buzz-postgres` container.)
log "Seeding community (host=${COMMUNITY_HOST}), channels, and members..."
BUZZ_COMMUNITY_HOST="${COMMUNITY_HOST}" \
  BUZZ_DB_HOST=localhost BUZZ_DB_PORT=${PG_PORT} BUZZ_DB_USER=buzz \
  BUZZ_DB_PASS=buzz_dev BUZZ_DB_NAME=buzz \
  BUZZ_DB_DOCKER_CONTAINER="${PROJECT}-postgres-1" \
  ./scripts/setup-desktop-test-data.sh
ok "Community + channels + members seeded"

# ── Build relay from source (current branch) ─────────────────────────────────
# The repo pins Rust via rust-toolchain.toml (1.95.0). Outside the hermit env a
# stray Homebrew `cargo` (1.89) shadows the pin and fails on sqlx's MSRV, so
# prefer the rustup shim, which honors the pin.
if [[ -x "${HOME}/.cargo/bin/cargo" ]]; then
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi
log "Building relay (profile=${CARGO_BUILD_PROFILE}, cargo=$(command -v cargo), $(cargo --version))..."
cargo build --profile "${CARGO_BUILD_PROFILE}" -p buzz-relay
ok "Relay built"

# ── Run relay (detached tmux session) ────────────────────────────────────────
# Run inside tmux, NOT the foreground: this script is invoked from ephemeral
# shells whose process group is reaped on return, which SIGTERMs a foreground
# relay ~seconds after startup. tmux fully daemonizes the session so the relay
# survives (same pattern the perf stack uses). Logs to ${RELAY_LOG}.
log "Starting relay in tmux session '${TMUX_SESSION}' on :${RELAY_MAIN} (health :${RELAY_HEALTH}, metrics :${RELAY_METRICS})..."
tmux new-session -d -s "${TMUX_SESSION}" "cd '${REPO_ROOT}' && env \
  DATABASE_URL=postgres://buzz:buzz_dev@localhost:${PG_PORT}/buzz \
  REDIS_URL=redis://localhost:${REDIS_PORT} \
  RELAY_URL=ws://localhost:${RELAY_MAIN} \
  BUZZ_BIND_ADDR=0.0.0.0:${RELAY_MAIN} \
  BUZZ_HEALTH_PORT=${RELAY_HEALTH} \
  BUZZ_METRICS_PORT=${RELAY_METRICS} \
  BUZZ_S3_ENDPOINT=http://localhost:${MINIO_PORT} \
  BUZZ_S3_ACCESS_KEY=buzz_dev \
  BUZZ_S3_SECRET_KEY=buzz_dev_secret \
  BUZZ_S3_BUCKET=buzz-media \
  BUZZ_REQUIRE_AUTH_TOKEN=false \
  BUZZ_RECONCILE_CHANNELS=true \
  BUZZ_DISCOVERY_EXTERNAL_WORKER_ENABLED='${DISCOVERY_EXTERNAL_WORKER_ENABLED}' \
  BUZZ_DISCOVERY_FAKE_EXECUTOR_ENABLED='${DISCOVERY_FAKE_EXECUTOR_ENABLED}' \
  BUZZ_DISCOVERY_LEASE_SECONDS='${DISCOVERY_LEASE_SECONDS}' \
  BUZZ_RELAY_PRIVATE_KEY='${RELAY_PRIVATE_KEY}' \
  './target/${CARGO_TARGET_PROFILE}/buzz-relay' > '${RELAY_LOG}' 2>&1"

# Wait for the main port to accept connections.
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:${RELAY_MAIN}/"; then
    ok "Relay live — BUZZ_E2E_RELAY_URL=http://localhost:${RELAY_MAIN}"
    ok "Logs: ${RELAY_LOG}   Attach: tmux attach -t ${TMUX_SESSION}"
    ok "Stop relay: tmux kill-session -t ${TMUX_SESSION}"
    ok "Full teardown: docker compose -p ${PROJECT} -f ${COMPOSE_FILE} down -v"
    exit 0
  fi
  sleep 1
done
err "Relay did not come up on :${RELAY_MAIN} within 30s — check ${RELAY_LOG}"
exit 1
