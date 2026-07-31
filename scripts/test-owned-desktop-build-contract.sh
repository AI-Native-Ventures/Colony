#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_SCRIPT="${REPO_ROOT}/scripts/build-owned-desktop.sh"
TEST_TMP_DIR="$(mktemp -d)"
RELAY_MARKER="${TEST_TMP_DIR}/relay-injection-ran"
TARGET_MARKER="${TEST_TMP_DIR}/target-injection-ran"

cleanup() {
  rm -f -- "${RELAY_MARKER}" "${TARGET_MARKER}"
  rmdir "${TEST_TMP_DIR}"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_rejected() {
  if env -u BUZZ_OWNED_RELAY_URL \
    BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" "$@" >/dev/null 2>&1; then
    fail "expected wrapper rejection: $*"
  fi
}

expect_equal() {
  local actual="$1"
  local expected="$2"
  [[ "${actual}" == "${expected}" ]] ||
    fail "expected '${expected}', got '${actual}'"
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
expect_rejected --relay ' wss://office.example.com'
expect_rejected --relay 'wss://office.example.com '
expect_rejected --relay $'wss://office.example.com\t'
expect_rejected --relay $'wss://office.example.com\n'
expect_rejected --relay $'wss://office.example.com\x1f'
expect_rejected --relay $'wss://office.example.com\x7f'
expect_rejected --relay wss://office.example.com --target not-a-rust-target
expect_rejected --relay wss://office.example.com \
  --target $'x86_64-apple-darwin\nx86_64-unknown-linux-gnu'
expect_rejected --relay wss://office.example.com \
  --target 'x86_64-apple-darwin; touch should-not-run'

output="$(
  BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" \
    --relay wss://office.example.com \
    --target x86_64-apple-darwin
)"
expect_equal "${output}" \
  "BUZZ_RELAY_URL=wss://office.example.com BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1 just desktop-release-build x86_64-apple-darwin"

output="$(
  BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" \
    --relay WSS://OFFICE.EXAMPLE.COM:443/ \
    --target x86_64-apple-darwin
)"
expect_equal "${output}" \
  "BUZZ_RELAY_URL=wss://office.example.com BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1 just desktop-release-build x86_64-apple-darwin"

output="$(
  BUZZ_OWNED_RELAY_URL=wss://office.example.com \
    BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" \
    --target aarch64-apple-darwin
)"
expect_equal "${output}" \
  "BUZZ_RELAY_URL=wss://office.example.com BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1 just desktop-release-build aarch64-apple-darwin"

host_target="$(rustc -vV | awk '/^host:/ { print $2 }')"
[[ -n "${host_target}" ]] || fail "rustc did not report a host target"
output="$(
  BUZZ_OWNED_BUILD_DRY_RUN=1 \
    "${BUILD_SCRIPT}" \
    --relay wss://office.example.com
)"
expect_equal "${output}" \
  "BUZZ_RELAY_URL=wss://office.example.com BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1 just desktop-release-build ${host_target}"

output="$(
  cd "${REPO_ROOT}"
  BUZZ_OWNED_BUILD_DRY_RUN=1 \
    just --quiet desktop-owned-build \
    wss://office.example.com \
    --target x86_64-apple-darwin
)"
expect_equal "${output}" \
  "BUZZ_RELAY_URL=wss://office.example.com BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1 just desktop-release-build x86_64-apple-darwin"

hostile_relay="wss://office.example.com\"; touch \"${RELAY_MARKER}\"; #"
if (
  cd "${REPO_ROOT}"
  BUZZ_OWNED_BUILD_DRY_RUN=1 \
    just --quiet desktop-owned-build \
    "${hostile_relay}" \
    --target x86_64-apple-darwin
) >/dev/null 2>&1; then
  fail "expected Just relay injection attempt to be rejected"
fi
[[ ! -e "${RELAY_MARKER}" ]] ||
  fail "Just relay argument executed shell input"

hostile_target="x86_64-apple-darwin; touch ${TARGET_MARKER}"
if (
  cd "${REPO_ROOT}"
  BUZZ_OWNED_BUILD_DRY_RUN=1 \
    just --quiet desktop-owned-build \
    wss://office.example.com \
    --target "${hostile_target}"
) >/dev/null 2>&1; then
  fail "expected Just target injection attempt to be rejected"
fi
[[ ! -e "${TARGET_MARKER}" ]] ||
  fail "Just target argument executed shell input"

echo "owned desktop build contract passed"
