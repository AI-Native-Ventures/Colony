#!/usr/bin/env bash
# =============================================================================
# run-tests.sh — Run Buzz test suite
# =============================================================================
# Usage:
#   ./scripts/run-tests.sh              # run all tests (default)
#   ./scripts/run-tests.sh unit         # unit tests only (no infra needed)
#   ./scripts/run-tests.sh integration  # integration tests only
#   ./scripts/run-tests.sh all          # explicit all
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODE="${1:-all}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log()    { echo -e "${BLUE}[run-tests]${NC} $*"; }
success(){ echo -e "${GREEN}[run-tests]${NC} $*"; }
warn()   { echo -e "${YELLOW}[run-tests]${NC} $*"; }
error()  { echo -e "${RED}[run-tests]${NC} $*" >&2; }
section(){ echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${CYAN}  $*${NC}"; echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

cd "${REPO_ROOT}"

# ---- Load .env if present ---------------------------------------------------

if [[ -f ".env" ]]; then
  log "Loading .env..."
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
else
  # Use defaults matching docker-compose.yml
  export DATABASE_URL="postgres://buzz:buzz_dev@localhost:5432/buzz" # sadscan:disable np.postgres.1
  export PGHOST=localhost
  export PGPORT=5432
  export PGUSER=buzz
  export PGPASSWORD=buzz_dev
  export PGDATABASE=buzz
  export REDIS_URL="redis://localhost:6379"
fi

# ---- Track results ----------------------------------------------------------

declare -a PASSED=()
declare -a FAILED=()

run_test_step() {
  local name="$1"
  shift
  log "Running: ${name}"
  if "$@"; then
    success "${name} passed"
    PASSED+=("${name}")
  else
    error "${name} FAILED"
    FAILED+=("${name}")
  fi
}

# ---- Check / start infra (for integration tests) ----------------------------

ensure_infra() {
  "${REPO_ROOT}/bin/just" _ensure-migrations
}

# ---- Unit tests (no infra needed) -------------------------------------------

run_unit_tests() {
  section "Unit Tests (no infra required)"

  # Compile gate, first because everything below it is scoped by hand.
  #
  # The steps in this function name crates individually, and that list covers 7
  # of the workspace's 29 members. A change to a shared type therefore breaks
  # unnamed crates without any local gate noticing: making `PriceEntry::origin`
  # required left `buzz-test-client` uncompilable, `just test-unit` passed, the
  # pre-push hook passed, and (develop-targeted PRs run no CI) it merged.
  #
  # `--all-targets` is what makes this work: the break was in a test file, which
  # a plain `cargo check` does not compile. This does not run anyone's tests --
  # it proves every crate and every test target in the workspace still builds,
  # which is the failure the hand-scoped list structurally cannot see. Cheaper
  # than `just clippy` (no lint passes) and it front-loads the compilation the
  # steps below need anyway.
  run_test_step "workspace compiles (all targets)" \
    cargo check --workspace --all-targets --quiet

  run_test_step "buzz-core tests" \
    cargo test -p buzz-core --lib -- --nocapture

  run_test_step "buzz-auth unit tests" \
    cargo test -p buzz-auth --lib -- --nocapture

  run_test_step "buzz-voice tests" \
    cargo test -p buzz-voice --lib -- --nocapture

  run_test_step "buzz-cli tests" \
    cargo test -p buzz-cli -- --nocapture

  # buzz-acp: agent prompt contracts and pool/queue logic. Infra-free, and
  # previously absent from both unit paths — a broken base-prompt assertion sat
  # red without any gate noticing.
  run_test_step "buzz-acp unit tests" \
    cargo test -p buzz-acp --lib -- --nocapture

  # buzz-db migrator/lint unit tests (no infra): guard the embedded-migrator
  # invariant (exactly the consolidated 0001; cutover/backfill stays an operator
  # script, not startup state) and the tenant-scoping lints. The Postgres-backed
  # buzz-db tests are #[ignore]d; nothing here (or in integration mode below,
  # which runs `cargo test -p buzz-db` without --ignored) runs them — they need a
  # separate isolated-DB gate, so --lib keeps this step infra-free.
  run_test_step "buzz-db unit tests" \
    cargo test -p buzz-db --lib -- --nocapture

  # Multi-tenant conformance gate: independent replay checker + golden
  # fixtures (buzz-conformance). Pure in-process trace replay, no infra.
  run_test_step "buzz-conformance tests" \
    cargo test -p buzz-conformance -- --nocapture

  run_test_step "buzz-push-gateway tests" \
    cargo test -p buzz-push-gateway -- --nocapture
}

# ---- DB / integration tests (infra required) --------------------------------

run_integration_tests() {
  section "Integration Tests (requires running services)"

  ensure_infra

  run_test_step "buzz-db tests" \
    cargo test -p buzz-db -- --nocapture

  if find crates/buzz-auth/tests -maxdepth 1 -name '*.rs' -print -quit 2>/dev/null | grep -q .; then
    run_test_step "buzz-auth integration tests" \
      cargo test -p buzz-auth --test '*' -- --nocapture
  else
    run_test_step "buzz-auth (no integration tests found)" true
  fi

  run_test_step "workspace integration tests" \
    cargo test --test '*' -- --nocapture 2>/dev/null || \
    run_test_step "workspace integration tests (none found)" true
}

# ---- Main -------------------------------------------------------------------

START_TIME=$(date +%s)

case "${MODE}" in
  unit)
    run_unit_tests
    ;;
  integration)
    run_integration_tests
    ;;
  all|*)
    run_unit_tests
    run_integration_tests
    ;;
esac

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# ---- Summary ----------------------------------------------------------------

section "Test Summary"
echo ""
echo -e "  Duration: ${ELAPSED}s"
echo ""

if [[ ${#PASSED[@]} -gt 0 ]]; then
  echo -e "  ${GREEN}Passed (${#PASSED[@]}):${NC}"
  for t in "${PASSED[@]}"; do
    echo -e "    ${GREEN}pass${NC} ${t}"
  done
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo ""
  echo -e "  ${RED}Failed (${#FAILED[@]}):${NC}"
  for t in "${FAILED[@]}"; do
    echo -e "    ${RED}fail${NC} ${t}"
  done
  echo ""
  exit 1
fi

echo ""
success "All tests passed!"
exit 0
