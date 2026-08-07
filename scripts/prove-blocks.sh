#!/usr/bin/env bash
# Proves the Blocks Gate C path against an isolated, real relay/CLI/ACP tuple.
# This is deliberately orchestration-only: production behavior belongs in the
# relay, CLI, ACP, and desktop live spec, not here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# Hermit is the repository's pinned toolchain. Source it before resolving any
# command so a system Node or Cargo cannot accidentally prove a different build.
# shellcheck disable=SC1091
. ./bin/activate-hermit
# shellcheck source=scripts/harness-ports.sh
source "${SCRIPT_DIR}/harness-ports.sh"

fail() { printf 'prove-blocks: %s\n' "$*" >&2; exit 1; }
require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

for command in docker tmux curl node pnpm cargo; do
  require_command "${command}"
done
docker compose version >/dev/null 2>&1 || fail "docker compose is unavailable"

readonly RELAY_PRIVATE_KEY="0000000000000000000000000000000000000000000000000000000000000001"
readonly RELAY_SELF="79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
readonly OWNER_PUBKEY="e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34"
readonly AGENT_PRIVATE_KEY="813fc3bb90587a82b2bfee9b833503e7686c7480681850b3d789c6987e997fc8"
readonly AGENT_AUTH_TAG='["auth","e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34","","b7634ac722501fe8031046ca577e67c8c3e90167e01c43bf285525129f6c726a12ab4acc2276fcc37fa0f4ef9ebb952ab0e5486a9b608d06cc132d3fc4096b4a"]'
readonly RELAY_HTTP_URL="${HARNESS_RELAY_HTTP_URL}"
readonly RELAY_WS_URL="${HARNESS_RELAY_WS_URL}"
readonly DATABASE_URL="${HARNESS_DATABASE_URL}"
readonly CARGO_PROFILE="${CARGO_PROFILE:-ci}"
readonly CARGO_BUILD_PROFILE="$([[ "${CARGO_PROFILE}" == "dev" || "${CARGO_PROFILE}" == "debug" ]] && printf dev || printf '%s' "${CARGO_PROFILE}")"
readonly TARGET_PROFILE="$([[ "${CARGO_PROFILE}" == "dev" || "${CARGO_PROFILE}" == "debug" ]] && printf debug || printf '%s' "${CARGO_PROFILE}")"
readonly RELAY_LOG="${RELAY_LOG:-/tmp/blocks-relay-${HARNESS_RELAY_PORT}.log}"
readonly ACP_LOG="${ACP_LOG:-/tmp/blocks-acp-${HARNESS_RELAY_PORT}.log}"
readonly RELAY_TMUX_SESSION="${RELAY_TMUX_SESSION:-blocks-relay-${HARNESS_RELAY_PORT}}"
readonly ACP_TMUX_SESSION="${ACP_TMUX_SESSION:-blocks-acp-${HARNESS_RELAY_PORT}}"
readonly ACP_FIXTURE="${REPO_ROOT}/desktop/tests/e2e/fixtures/fake-acp-agent.mjs"

mkdir -p "${REPO_ROOT}/desktop/test-results/blocks/gate-c"

echo "[blocks] harness port set: relay :${HARNESS_RELAY_PORT}, pg :${HARNESS_PG_PORT}, redis :${HARNESS_REDIS_PORT}, minio :${HARNESS_MINIO_PORT}, health :${HARNESS_HEALTH_PORT}, metrics :${HARNESS_METRICS_PORT} (compose project ${HARNESS_PROJECT})"
echo "[blocks] building real relay, CLI, and ACP binaries (profile=${CARGO_BUILD_PROFILE})..."
cargo build --profile "${CARGO_BUILD_PROFILE}" -p buzz-relay -p buzz-cli -p buzz-acp

export BUZZ_E2E_BLOCKS_LIVE=1
export BUZZ_E2E_RELAY_HTTP_URL="${RELAY_HTTP_URL}"
export BUZZ_E2E_RELAY_WS_URL="${RELAY_WS_URL}"
export BUZZ_E2E_RELAY_BIN="${REPO_ROOT}/target/${TARGET_PROFILE}/buzz-relay"
export BUZZ_E2E_CLI_BIN="${REPO_ROOT}/target/${TARGET_PROFILE}/buzz"
export BUZZ_E2E_ACP_BIN="${REPO_ROOT}/target/${TARGET_PROFILE}/buzz-acp"
export BUZZ_E2E_DATABASE_URL="${DATABASE_URL}"
export BUZZ_E2E_HARNESS_PROJECT="${HARNESS_PROJECT}"
export BUZZ_E2E_EVIDENCE_DIR="${REPO_ROOT}/desktop/test-results/blocks/gate-c"
export BUZZ_E2E_AGENT_AUTH_TAG="${AGENT_AUTH_TAG}"
export BUZZ_E2E_APPROVAL_COUNTER="${BUZZ_E2E_EVIDENCE_DIR}/approval-counter.json"

for binary in "${BUZZ_E2E_RELAY_BIN}" "${BUZZ_E2E_CLI_BIN}" "${BUZZ_E2E_ACP_BIN}"; do
  [[ -x "${binary}" ]] || fail "expected built binary is not executable: ${binary}"
done
[[ -f "${ACP_FIXTURE}" ]] || fail "deterministic ACP fixture is missing: ${ACP_FIXTURE}"

echo "[blocks] running required desktop native Agent Proposal checks..."
cargo test --manifest-path desktop/src-tauri/Cargo.toml agent_proposal

# start-isolated-test-relay.sh owns the isolated Docker tuple and starts the
# relay in its own tmux session. tmux servers retain their initial environment,
# so set both identities explicitly on the server before it creates the session.
export BUZZ_RELAY_PRIVATE_KEY="${RELAY_PRIVATE_KEY}"
export RELAY_OWNER_PUBKEY="${OWNER_PUBKEY}"
export RELAY_LOG
export TMUX_SESSION="${RELAY_TMUX_SESSION}"
# A tmux server may not exist yet, and `set-environment -g` fails without one.
# Keep a short-lived anchor session while installing the exact relay process
# environment, then remove the global copies once the relay session has cloned
# them. This avoids depending on whatever shell first happened to start tmux.
readonly TMUX_ENV_ANCHOR="${RELAY_TMUX_SESSION}-env"
tmux kill-session -t "${TMUX_ENV_ANCHOR}" 2>/dev/null || true
tmux new-session -d -s "${TMUX_ENV_ANCHOR}" "sleep 600"
tmux set-environment -g BUZZ_RELAY_PRIVATE_KEY "${BUZZ_RELAY_PRIVATE_KEY}"
tmux set-environment -g RELAY_OWNER_PUBKEY "${RELAY_OWNER_PUBKEY}"

echo "[blocks] starting isolated relay on ${RELAY_HTTP_URL} (Postgres :${HARNESS_PG_PORT}, Redis :${HARNESS_REDIS_PORT})..."
env CARGO_PROFILE="${CARGO_PROFILE}" \
  ./scripts/start-isolated-test-relay.sh --profile "${CARGO_PROFILE}"

relay_info="$(curl --fail --silent --show-error --header 'Accept: application/nostr+json' "${RELAY_HTTP_URL}/")"
node -e '
const [body, expected] = process.argv.slice(1);
const info = JSON.parse(body);
const actual = info.self ?? info.relay_self;
if (actual !== expected) {
  throw new Error(`NIP-11 self mismatch: expected ${expected}, got ${actual ?? "missing"}`);
}
' "${relay_info}" "${RELAY_SELF}" || fail "relay did not inherit the configured stable identity"
tmux set-environment -gu BUZZ_RELAY_PRIVATE_KEY
tmux set-environment -gu RELAY_OWNER_PUBKEY
tmux kill-session -t "${TMUX_ENV_ANCHOR}" 2>/dev/null || true
echo "[blocks] NIP-11 self verified: ${RELAY_SELF}"

# Keep this deterministic fixture separate from the relay and preserve its
# prompt log as Gate C evidence. The test owns channel/agent provisioning.
tmux kill-session -t "${ACP_TMUX_SESSION}" 2>/dev/null || true
rm -f \
  "${ACP_LOG}" \
  "${BUZZ_E2E_EVIDENCE_DIR}/acp-prompts.log" \
  "${BUZZ_E2E_APPROVAL_COUNTER}"
tmux new-session -d -s "${ACP_TMUX_SESSION}" "cd '${REPO_ROOT}' && env \
  BUZZ_RELAY_URL='${RELAY_WS_URL}' \
  BUZZ_PRIVATE_KEY='${AGENT_PRIVATE_KEY}' \
  BUZZ_AUTH_TAG='${AGENT_AUTH_TAG}' \
  BUZZ_ACP_AGENT_OWNER='${OWNER_PUBKEY}' \
  BUZZ_ACP_RESPOND_TO='anyone' \
  BUZZ_ACP_NO_MEMORY='true' \
  BUZZ_ACP_AGENT_COMMAND='$(command -v node)' \
  BUZZ_ACP_AGENT_ARGS='${ACP_FIXTURE}' \
  BUZZ_E2E_CLI_BIN='${BUZZ_E2E_CLI_BIN}' \
  BUZZ_E2E_ACP_PROMPT_LOG='${BUZZ_E2E_EVIDENCE_DIR}/acp-prompts.log' \
  BUZZ_E2E_APPROVAL_COUNTER='${BUZZ_E2E_APPROVAL_COUNTER}' \
  '${BUZZ_E2E_ACP_BIN}' > '${ACP_LOG}' 2>&1"
sleep 1
tmux has-session -t "${ACP_TMUX_SESSION}" 2>/dev/null || fail "deterministic ACP exited; inspect ${ACP_LOG}"

cat <<EOF
[blocks] Gate C environment exported for this script and any command it launches:
  BUZZ_E2E_BLOCKS_LIVE=${BUZZ_E2E_BLOCKS_LIVE}
  BUZZ_E2E_RELAY_HTTP_URL=${BUZZ_E2E_RELAY_HTTP_URL}
  BUZZ_E2E_RELAY_WS_URL=${BUZZ_E2E_RELAY_WS_URL}
  BUZZ_E2E_RELAY_BIN=${BUZZ_E2E_RELAY_BIN}
  BUZZ_E2E_CLI_BIN=${BUZZ_E2E_CLI_BIN}
  BUZZ_E2E_ACP_BIN=${BUZZ_E2E_ACP_BIN}
  BUZZ_E2E_DATABASE_URL=${BUZZ_E2E_DATABASE_URL}
  BUZZ_E2E_EVIDENCE_DIR=${BUZZ_E2E_EVIDENCE_DIR}
  BUZZ_E2E_AGENT_AUTH_TAG=<deterministic test-only NIP-OA tag>
  BUZZ_E2E_APPROVAL_COUNTER=${BUZZ_E2E_APPROVAL_COUNTER}

[blocks] Services remain running; logs are intentionally retained:
  relay: ${RELAY_LOG}  (tmux attach -t ${RELAY_TMUX_SESSION})
  ACP:   ${ACP_LOG}  (tmux attach -t ${ACP_TMUX_SESSION})
EOF

tail -n 20 "${RELAY_LOG}" || true
tail -n 20 "${ACP_LOG}" || true

readonly PLAYWRIGHT_COMMAND="pnpm exec playwright test tests/e2e/blocks-live.spec.ts --project=integration"
if [[ -f desktop/tests/e2e/blocks-live.spec.ts ]]; then
  echo "[blocks] building the real desktop E2E bundle..."
  (cd desktop && pnpm build:e2e)
  echo "[blocks] running: ${PLAYWRIGHT_COMMAND}"
  (
    cd desktop
    CI=1 pnpm exec playwright test tests/e2e/blocks-live.spec.ts --project=integration --workers=1
  )
else
  echo "[blocks] blocks-live spec is not present yet. Once added, run:"
  echo "  cd ${REPO_ROOT}/desktop && ${PLAYWRIGHT_COMMAND}"
fi

# The Playwright spec recreates the evidence directory at startup. Pin the
# proven revision and final worktree state only after that cleanup completes.
git rev-parse HEAD > "${BUZZ_E2E_EVIDENCE_DIR}/git-revision.txt"
git status --short --untracked-files=all -- . ':(exclude).codegraph' \
  > "${BUZZ_E2E_EVIDENCE_DIR}/git-status.txt"
