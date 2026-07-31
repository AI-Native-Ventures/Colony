#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="${REPO_ROOT}/scripts/build-owned-desktop.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_rejected() {
  if env -u BUZZ_OWNED_RELAY_URL \
    BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" "$@" >/dev/null 2>&1; then
    fail "expected rejection: $*"
  fi
}

expect_output() {
  local output="$1"
  local expected="$2"
  [[ "${output}" == *"${expected}"* ]] ||
    fail "expected output to contain: ${expected}"
}

expect_rejected
expect_rejected --relay ws://office.example.com
expect_rejected --relay https://office.example.com
expect_rejected --relay malformed
expect_rejected --relay wss://user:pass@office.example.com
expect_rejected --relay 'wss://office.example.com?tenant=horizon'
expect_rejected --relay 'wss://office.example.com#fragment'
expect_rejected --relay wss://office.example.com/socket
expect_rejected --relay wss://localhost
expect_rejected --relay wss://127.0.0.1
expect_rejected --relay 'wss://[::1]'
expect_rejected --relay wss://0.0.0.0
expect_rejected --relay wss://192.0.2.1

output="$(
  BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" \
    --relay wss://office.example.com \
    --target x86_64-apple-darwin
)"
expect_output "${output}" "BUZZ_RELAY_URL=wss://office.example.com"
expect_output "${output}" "BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1"
expect_output "${output}" "just desktop-release-build x86_64-apple-darwin"

output="$(
  BUZZ_OWNED_RELAY_URL=wss://office.example.com \
    BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" \
    --target aarch64-apple-darwin
)"
expect_output "${output}" "just desktop-release-build aarch64-apple-darwin"

output="$(
  BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" \
    --relay wss://office.example.com
)"
expect_output "${output}" "just desktop-release-build "

echo "owned desktop build contract passed"
