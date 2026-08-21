#!/usr/bin/env bash
# =============================================================================
# run-real-shell-e2e.sh — run the real-shell E2E smoke suite
# =============================================================================
# Drives a PACKAGED Tauri build (real backend) through eight smoke flows:
#   01 launch-to-first-paint    boot, keychain unlock, window creation
#   02 onboard identity         secret_store.rs against the real OS keychain
#   03 join + message           live relay socket and push
#   04 managed agent spawn/stop sidecar spawn, protected PID set, reaper
#   05 huddle + brief transmit  audio devices, raw binary IPC
#   06 terminal PTY + normal exit real shell sessions, community boundary
#   07 terminal PTY + SIGTERM process-tree cleanup
#   08 web CDP screencast       packaged IPC and one real browser frame
#
# Backend: reuses the repo's isolated relay harness
# (scripts/start-isolated-test-relay.sh, tmux dawn-relay, port 3040,
# buzz-harness compose) — the exact harness prior work in this epic used.
# A live relay on :3040 is reused as-is; a tmux-capable host starts the
# official script; a host without tmux (e.g. some CI runners) gets the
# inline nohup fallback. A fresh clone needs only: docker, tmux (optional),
# hermit, and this script.
#
# State isolation: the harness app uses bundle id xyz.block.buzz.app.harness
# (never the real app's id), so storage, caches, and install are separate
# from the real app and reset per run.
#
# Keychain policy (Phase 0, deliberate): this script NEVER switches the
# machine's default keychain and never mutates any keychain item. The harness
# app is built with the crate's `system-keyring` feature disabled (see
# scripts/build-real-shell-app.sh), so probe() returns Unreachable without
# calling the Security Server and identity resolution runs through the app's
# real 0o600 identity.key path in the harness data dir. Flow 02 still probes
# the production OS-keychain item READ-ONLY (timeout-bounded) and records the
# keychain leg as a LOUD skip with the exact reason; see
# desktop/e2e-real-shell/README.md.
#
# Usage:
#   ./scripts/run-real-shell-e2e.sh [--no-build] [--flow 01] [--flow 02] ...
#
# Exit code: 0 when every selected flow passed or skipped loudly; 1 when any
# flow failed. Skips are reported in the output and in the result ledger.
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

FLOWS=()
NO_BUILD=0
RELAY_MODE="${BUZZ_REAL_SHELL_RELAY_MODE:-auto}"
while (($#)); do
  case "$1" in
    --no-build) NO_BUILD=1; shift ;;
    --flow) FLOWS+=("$2"); shift 2 ;;
    --relay-mode) RELAY_MODE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "error: unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [[ ${#FLOWS[@]} -eq 0 ]]; then
  FLOWS=(01 02 03 04 05 06 07 08)
fi

# ── Resolve harness configuration ────────────────────────────────────────────
HARNESS_IDENTIFIER="xyz.block.buzz.app.harness"
RELAY_PORT="${BUZZ_HARNESS_RELAY_PORT:-3040}"
RELAY_WS="ws://localhost:${RELAY_PORT}"
RELAY_HTTP="http://localhost:${RELAY_PORT}"
APP_BUNDLE="desktop/src-tauri/target/release/bundle/macos/Colony.app"
RESULTS_DIR="desktop/e2e-real-shell/results"
RESULTS_FILE="${REPO_ROOT}/${RESULTS_DIR}/flow-results.jsonl"
IDENTITY_STATE="/tmp/buzz-real-shell-identity.json"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; NC='\033[0m'
log() { echo -e "${BLUE}[real-shell]${NC} $*"; }
ok()  { echo -e "${GREEN}[real-shell]${NC} $*"; }
err() { echo -e "${RED}[real-shell]${NC} $*" >&2; }
warn(){ echo -e "${YELLOW}[real-shell]${NC} $*"; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  err "real-shell harness is macOS-only in Phase 0 (Windows/Linux come in Phase 3)."
  exit 1
fi

# ── Relay: reuse, official script, or inline nohup fallback ─────────────────
relay_live() { curl -s -o /dev/null --max-time 3 "${RELAY_HTTP}/"; }

start_relay() {
  if relay_live; then
    ok "Reusing live relay on :${RELAY_PORT} (${RELAY_WS})"
    return 0
  fi
  case "${RELAY_MODE}" in
    reuse)
      err "relay is not live on :${RELAY_PORT} but --relay-mode reuse was requested"
      exit 1
      ;;
    nohup)
      start_relay_nohup
      return 0
      ;;
    script)
      start_relay_script
      return 0
      ;;
  esac
  # auto: try the official script, then the CI-style fallback.
  if command -v tmux >/dev/null 2>&1; then
    if start_relay_script; then
      return 0
    fi
    warn "start-isolated-test-relay.sh refused (likely another worktree owns the port set); falling back to the nohup path, which reuses the seeded database without reset."
  fi
  start_relay_nohup
}

start_relay_script() {
  log "Starting isolated relay harness (tmux dawn-relay-${RELAY_PORT})..."
  export BUZZ_DISCOVERY_EXTERNAL_WORKER_ENABLED=true
  export BUZZ_DISCOVERY_FAKE_EXECUTOR_ENABLED=false
  export BUZZ_DISCOVERY_LEASE_SECONDS=5
  ./scripts/start-isolated-test-relay.sh --profile ci
  if ! relay_live; then
    err "relay did not come up after start-isolated-test-relay.sh"
    return 1
  fi
  return 0
}

start_relay_nohup() {
  if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
    err "docker is required for the relay backing services (postgres/redis/minio) and is not available."
    err "Install Docker or run on a host with tmux + the repo's isolated harness."
    exit 1
  fi
  local project="buzz-harness-${RELAY_PORT}"
  local compose_file="docker-compose.harness.yml"
  local pg_port="${BUZZ_HARNESS_PG_PORT:-5481}"
  local redis_port="${BUZZ_HARNESS_REDIS_PORT:-6481}"
  local minio_port="${BUZZ_HARNESS_MINIO_PORT:-9481}"
  local health_port="${BUZZ_HARNESS_HEALTH_PORT:-8098}"
  local metrics_port="${BUZZ_HARNESS_METRICS_PORT:-9212}"
  local relay_log="/tmp/dawn-relay-${RELAY_PORT}.log"

  export BUZZ_HARNESS_PG_PORT="${pg_port}"
  export BUZZ_HARNESS_REDIS_PORT="${redis_port}"
  export BUZZ_HARNESS_MINIO_PORT="${minio_port}"
  export BUZZ_HARNESS_MINIO_CONSOLE_PORT="${BUZZ_HARNESS_MINIO_CONSOLE_PORT:-9492}"
  export BUZZ_HARNESS_OWNER="${REPO_ROOT}"

  docker compose -p "${project}" -f "${compose_file}" up -d
  for _ in $(seq 1 60); do
    docker compose -p "${project}" -f "${compose_file}" exec -T postgres \
      pg_isready -U buzz >/dev/null 2>&1 && break
    sleep 2
  done

  # Schema + seed. Only reset when the database belongs to this run (no
  # pre-existing owner) — never wipe another worktree's harness.
  local owner=""
  local pg_container
  pg_container="$(docker compose -p "${project}" -f "${compose_file}" ps --status running -q postgres 2>/dev/null | head -1 || true)"
  if [[ -n "${pg_container}" ]]; then
    owner="$(docker inspect --format '{{if .Config.Labels}}{{if index .Config.Labels "dev.buzz.harness.owner"}}{{index .Config.Labels "dev.buzz.harness.owner"}}{{end}}{{end}}' "${pg_container}" 2>/dev/null || true)"
    if [[ -z "${owner}" ]]; then
      owner="$(docker inspect --format '{{if .Config.Labels}}{{index .Config.Labels "com.docker.compose.project.working_dir"}}{{end}}' "${pg_container}" 2>/dev/null || true)"
    fi
  fi
  if [[ -z "${owner}" || "${owner}" == "${REPO_ROOT}" ]]; then
    log "Resetting isolated database schema (project=${project})..."
    export PGPASSWORD=buzz_dev
    docker compose -p "${project}" -f "${compose_file}" exec -T postgres \
      psql -U buzz -d buzz -v ON_ERROR_STOP=1 -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
    export PGSCHEMA_PLAN_HOST=localhost PGSCHEMA_PLAN_PORT="${pg_port}"
    export PGSCHEMA_PLAN_DB=buzz PGSCHEMA_PLAN_USER=buzz PGSCHEMA_PLAN_PASSWORD=buzz_dev
    export PGHOST=localhost PGPORT="${pg_port}" PGUSER=buzz PGDATABASE=buzz
    # The stub downloads pgschema on first use; retry that fetch on its own so
    # a transient GitHub Releases error is not reported as a schema failure.
    ./scripts/ci-prefetch-hermit-pkg.sh pgschema
    ./bin/pgschema apply --file schema/schema.sql --auto-approve
    docker compose -p "${project}" -f "${compose_file}" exec -T postgres \
      psql -U buzz -d buzz -v ON_ERROR_STOP=1 < scripts/attach-schema-partitions.sql
  else
    warn "Backing services owned by ${owner}; reusing their database WITHOUT schema reset."
  fi

  log "Seeding community (host=localhost:${RELAY_PORT})..."
  BUZZ_COMMUNITY_HOST="localhost:${RELAY_PORT},127.0.0.1:${RELAY_PORT}" \
    BUZZ_DB_HOST=localhost BUZZ_DB_PORT="${pg_port}" BUZZ_DB_USER=buzz \
    BUZZ_DB_PASS=buzz_dev BUZZ_DB_NAME=buzz \
    BUZZ_DB_DOCKER_CONTAINER="${project}-postgres-1" \
    ./scripts/setup-desktop-test-data.sh

  if [[ ! -x "target/ci/buzz-relay" ]]; then
    log "Building relay (profile=ci)..."
    cargo build --profile ci -p buzz-relay
  fi

  log "Starting relay with nohup (log: ${relay_log})..."
  nohup env \
    DATABASE_URL="postgres://buzz:buzz_dev@localhost:${pg_port}/buzz" \
    REDIS_URL="redis://localhost:${redis_port}" \
    RELAY_URL="ws://localhost:${RELAY_PORT}" \
    BUZZ_BIND_ADDR="0.0.0.0:${RELAY_PORT}" \
    BUZZ_HEALTH_PORT="${health_port}" \
    BUZZ_METRICS_PORT="${metrics_port}" \
    BUZZ_S3_ENDPOINT="http://localhost:${minio_port}" \
    BUZZ_S3_ACCESS_KEY=buzz_dev BUZZ_S3_SECRET_KEY=buzz_dev_secret \
    BUZZ_S3_BUCKET=buzz-media BUZZ_REQUIRE_AUTH_TOKEN=false \
    BUZZ_RECONCILE_CHANNELS=true \
    BUZZ_DISCOVERY_EXTERNAL_WORKER_ENABLED=true \
    BUZZ_DISCOVERY_FAKE_EXECUTOR_ENABLED=false \
    BUZZ_DISCOVERY_LEASE_SECONDS=5 \
    "./target/ci/buzz-relay" > "${relay_log}" 2>&1 &
  RELAY_PID=$!
  for _ in $(seq 1 60); do
    if relay_live; then break; fi
    sleep 1
  done
  if ! relay_live; then
    err "relay did not come up; log tail:"; tail -20 "${relay_log}" >&2 || true
    exit 1
  fi
  ok "Relay live on :${RELAY_PORT} (pid ${RELAY_PID})"
}

# ── App state reset ──────────────────────────────────────────────────────────
kill_harness_app() {
  pkill -f "${REPO_ROOT}/desktop/src-tauri/target/release/bundle/macos/Colony.app" >/dev/null 2>&1 || true
  sleep 1
}

reset_app_state() {
  kill_harness_app
  for dir in \
    "$HOME/Library/Application Support/${HARNESS_IDENTIFIER}" \
    "$HOME/Library/Caches/${HARNESS_IDENTIFIER}" \
    "$HOME/Library/WebKit/${HARNESS_IDENTIFIER}" \
    "$HOME/Library/HTTPStorages/${HARNESS_IDENTIFIER}" \
    "$HOME/Library/Saved Application State/${HARNESS_IDENTIFIER}.savedState" \
    "$HOME/Library/Preferences/${HARNESS_IDENTIFIER}.plist"; do
    rm -rf -- "${dir}"
  done
  rm -f "${IDENTITY_STATE}"
  log "Harness app state reset (${HARNESS_IDENTIFIER})"
}

# ── Per-flow runner ──────────────────────────────────────────────────────────
run_flow() {
  local flow="$1"
  local spec
  spec="$(ls "desktop/e2e-real-shell/specs/${flow}-"*.spec.ts 2>/dev/null | head -1 || true)"
  if [[ -z "${spec}" ]]; then
    err "no spec found for flow ${flow}"
    return 1
  fi
  kill_harness_app
  log "Running flow ${flow} (${spec})..."
  local exit_code=0
  # wdio resolves a CLI --spec against the process CWD (empirically verified:
  # "./specs/<file>" from desktop/ matched desktop/specs/ and ran zero specs).
  # Config-file `specs:` globs resolve against the config dir, but --spec
  # overrides do not. Never forward through pnpm's arg parsing either (a
  # stray `--` makes wdio match zero specs).
  if (cd desktop && pnpm exec wdio run ./e2e-real-shell/wdio.conf.ts --spec "./e2e-real-shell/specs/$(basename "${spec}")" > "e2e-real-shell/results/${flow}.log" 2>&1); then
    ok "Flow ${flow} exited 0"
  else
    exit_code=$?
    err "Flow ${flow} exited ${exit_code} — see desktop/e2e-real-shell/results/${flow}.log"
    tail -60 "desktop/e2e-real-shell/results/${flow}.log" >&2 || true
    return 1
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────
main() {
  start_relay
  if [[ "${NO_BUILD}" -ne 1 ]]; then
    ./scripts/build-real-shell-app.sh
  fi
  if [[ ! -d "${APP_BUNDLE}" ]]; then
    err "harness app bundle missing: ${APP_BUNDLE} (run ./scripts/build-real-shell-app.sh)"
    exit 1
  fi

  # Spec typecheck: wdio transpiles specs at runtime, so type errors would
  # otherwise only surface mid-run. Cheap (<10s) gate before any flow starts.
  (cd desktop && pnpm harness:typecheck)

  reset_app_state

  mkdir -p "${RESULTS_DIR}"
  rm -f "${RESULTS_FILE}" "${IDENTITY_STATE}"

  export BUZZ_E2E_RELAY_URL="${RELAY_WS}"
  export BUZZ_RELAY_URL="${RELAY_WS}"
  export BUZZ_REAL_SHELL_APP="${REPO_ROOT}/${APP_BUNDLE}"
  export BUZZ_REAL_SHELL_IDENTITY_STATE="${IDENTITY_STATE}"
  export BUZZ_REAL_SHELL_RESULTS="${RESULTS_FILE}"

  local failed=0
  for flow in "${FLOWS[@]}"; do
    if ! run_flow "${flow}"; then
      failed=1
    fi
  done
  kill_harness_app

  echo
  echo "──────────────────────────────────────────────────────────────"
  echo " REAL-SHELL E2E SUMMARY (flows: ${FLOWS[*]})"
  echo "──────────────────────────────────────────────────────────────"
  if [[ -f "${RESULTS_FILE}" ]]; then
    cat "${RESULTS_FILE}"
  fi
  # Zero-coverage guard: a broken invocation (wrong spec path, config error)
  # must never read as a green run. An empty ledger means no flow executed.
  if [[ ! -s "${RESULTS_FILE}" ]]; then
    err "Ledger is empty — NO flow executed. A harness invocation bug, not a pass."
    failed=1
  fi
  if [[ "${failed}" -ne 0 ]]; then
    echo
    err "One or more flows failed. Full logs: desktop/e2e-real-shell/results/"
  else
    ok "All selected flows passed (or skipped loudly)."
  fi
  exit "${failed}"
}

main "$@"
