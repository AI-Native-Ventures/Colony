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
  local input_unset_line generated_unset_line build_line

  grep -Fqx -- '          BUZZ_RELAY_URL: ${{ env.COLONY_PRODUCTION_RELAY_WS_URL }}' <<<"${block}" ||
    fail "${name} does not inject the production relay WebSocket URL"
  grep -Fqx -- '          BUZZ_RELAY_HTTP: ${{ env.COLONY_PRODUCTION_RELAY_HTTP_URL }}' <<<"${block}" ||
    fail "${name} does not inject the production relay HTTP URL"
  if grep -Eq -- '(^|[[:space:]])(export[[:space:]]+)?BUZZ_(BUILD|DESKTOP_BUILD)_AUTO_CONNECT_DEFAULT_RELAY[[:space:]]*(=|:)' <<<"${block}"; then
    fail "${name} auto-connects fresh users to the membership-gated root relay"
  fi
  grep -Fqx -- '          unset BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY' <<<"${block}" ||
    fail "${name} does not clear an ambient default-relay auto-connect flag"
  grep -Fqx -- '          unset BUZZ_DESKTOP_BUILD_AUTO_CONNECT_DEFAULT_RELAY' <<<"${block}" ||
    fail "${name} does not clear an ambient compiled default-relay auto-connect flag"

  input_unset_line="$(grep -nFx -- '          unset BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY' <<<"${block}" | cut -d: -f1)"
  generated_unset_line="$(grep -nFx -- '          unset BUZZ_DESKTOP_BUILD_AUTO_CONNECT_DEFAULT_RELAY' <<<"${block}" | cut -d: -f1)"
  build_line="$(grep -nE -- '^[[:space:]]+(just desktop-release-build|cd desktop && pnpm tauri build)' <<<"${block}" | head -1 | cut -d: -f1)"
  [[ -n "${build_line}" ]] || fail "${name} has no recognized desktop build command"
  if (( input_unset_line >= build_line || generated_unset_line >= build_line )); then
    fail "${name} clears an auto-connect flag only after the desktop build starts"
  fi
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

late_unset_fixture=$'      - name: late unset fixture\n        env:\n          BUZZ_RELAY_URL: ${{ env.COLONY_PRODUCTION_RELAY_WS_URL }}\n          BUZZ_RELAY_HTTP: ${{ env.COLONY_PRODUCTION_RELAY_HTTP_URL }}\n        run: |\n          just desktop-release-build aarch64-apple-darwin src-tauri/tauri.release.conf.json\n          unset BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY\n          unset BUZZ_DESKTOP_BUILD_AUTO_CONNECT_DEFAULT_RELAY'
if (validate_build_block "late unset fixture" "${late_unset_fixture}") >/dev/null 2>&1; then
  fail "contract accepted auto-connect cleanup after the build command"
fi

echo "Colony desktop release relay contract passed"
