#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKFLOW="${1:-${REPO_ROOT}/.github/workflows/colony-desktop-release.yml}"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f "${WORKFLOW}" ]] || fail "workflow not found: ${WORKFLOW}"

expect_line() {
  local expected="$1"
  grep -Fqx -- "${expected}" "${WORKFLOW}" ||
    fail "missing exact workflow line: ${expected}"
}

# These values are part of the shipped app's production contract. The release
# workflow must not silently inherit the OSS desktop default (localhost).
expect_line "  COLONY_PRODUCTION_RELAY_WS_URL: wss://relay.colony.ainative.ventures"
expect_line "  COLONY_PRODUCTION_RELAY_HTTP_URL: https://relay.colony.ainative.ventures"

if grep -Eiq \
  '^[[:space:]]+(BUZZ_RELAY_(URL|HTTP)|COLONY_PRODUCTION_RELAY_(WS_URL|HTTP_URL)):[[:space:]].*localhost' \
  "${WORKFLOW}"; then
  fail "release relay wiring contains a localhost value"
fi

step_block() {
  local name="$1"
  awk -v step="      - name: ${name}" '
    $0 == step { found = 1; print; next }
    found && /^      - name: / { exit }
    found { print }
  ' "${WORKFLOW}"
}

validate_build_block() {
  local name="$1"
  local block="$2"

  grep -Fqx -- '          BUZZ_RELAY_URL: ${{ env.COLONY_PRODUCTION_RELAY_WS_URL }}' <<<"${block}" ||
    fail "${name} does not inject the production relay WebSocket URL"
  grep -Fqx -- '          BUZZ_RELAY_HTTP: ${{ env.COLONY_PRODUCTION_RELAY_HTTP_URL }}' <<<"${block}" ||
    fail "${name} does not inject the production relay HTTP URL"
  if grep -Eq -- '(^|[[:space:]])(export[[:space:]]+)?BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY[[:space:]]*(=|:)' <<<"${block}"; then
    fail "${name} auto-connects fresh users to the membership-gated root relay"
  fi
  grep -Fqx -- '          unset BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY' <<<"${block}" ||
    fail "${name} does not clear an ambient default-relay auto-connect flag"
}

expect_build_env() {
  local name="$1"
  local block
  block="$(step_block "${name}")"
  [[ -n "${block}" ]] || fail "missing release build step: ${name}"
  validate_build_block "${name}" "${block}"
}

expect_build_env "Build desktop app"
expect_build_env "Build Windows NSIS installer (unsigned)"

# Prove the guard rejects shell-style re-enablement as well as YAML env keys.
negative_fixture="$(step_block "Build desktop app")"$'\n          export BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1'
if (validate_build_block "negative fixture" "${negative_fixture}") >/dev/null 2>&1; then
  fail "contract accepted shell-style auto-connect re-enablement"
fi

echo "Colony desktop release relay contract passed"
