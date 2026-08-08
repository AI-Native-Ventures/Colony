#!/usr/bin/env bash
# =============================================================================
# build-real-shell-app.sh — build the real-shell E2E harness app
# =============================================================================
# Produces a release .app bundle with the WebDriverIO plugins compiled in:
#   desktop/src-tauri/target/release/bundle/macos/Colony.app
#
# The bundle identifier is overridden to xyz.block.buzz.app.harness so the
# harness never touches the real app's storage, keychain, or install. The
# wdio capability file is materialized from capabilities/wdio.json.harness for
# this build only (the template extension keeps it out of every other build).
#
# The crate's default feature set enables `system-keyring`. A release build
# hardcodes keyring service "buzz-desktop" (app_state_keyring.rs), and an
# ad-hoc-signed harness binary probing that production item can BLOCK for
# minutes on the Security Server (observed: boot stuck in
# SecKeychainFindGenericPassword with the machine's default keychain present).
# This harness is the app's own sanctioned no-keyring path: `--no-default-
# features` (passed through to cargo after the `--`) drops `system-keyring`,
# so probe() returns Unreachable without touching the Security Server and
# identity resolution uses the existing 0o600-file fallback. The shipping
# build keeps system-keyring enabled — this flag never leaves this script.
#
# Real sidecar binaries are required (the flow-04 smoke test spawns one):
# cargo builds buzz-acp/buzz-agent/buzz-dev-mcp/git-credential-nostr/buzz-cli
# in release when the expected artifacts are missing.
#
# Do NOT run any other desktop-crate cargo build (just ci, cargo clippy/test
# in desktop/src-tauri) while this script runs: the materialized wdio.json
# capability is only valid with the wdio-harness feature enabled, and a
# concurrent default-feature build fails on `Permission wdio:default not found`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

CAPABILITY_TEMPLATE="desktop/src-tauri/capabilities/wdio.json.harness"
CAPABILITY_ACTIVE="${REPO_ROOT}/desktop/src-tauri/capabilities/wdio.json"
HARNESS_IDENTIFIER="xyz.block.buzz.app.harness"

cleanup() {
  # Absolute path: the script `cd`s into desktop/ for the frontend build, so a
  # repo-root-relative path would silently no-op here.
  rm -f "${CAPABILITY_ACTIVE}"
}
trap cleanup EXIT INT TERM

# Self-heal: a previous build killed between materialize and cleanup leaves
# the active capability file behind, which then breaks desktop-tauri-clippy.
rm -f "${CAPABILITY_ACTIVE}"

# 1. Sidecars: Tauri validates externalBin at build time; real binaries let
#    flow 04 spawn an actual agent runtime.
HOST="$(rustc -vV | sed -n 's|host: ||p')"
SIDECAR_NAMES=(buzz-acp buzz-agent buzz-dev-mcp git-credential-nostr buzz)
missing_sidecars=()
for bin in "${SIDECAR_NAMES[@]}"; do
  if [[ ! -x "target/release/${bin}" ]]; then
    missing_sidecars+=("${bin}")
  fi
done
if [[ ${#missing_sidecars[@]} -gt 0 ]]; then
  echo "[real-shell] building missing release sidecars: ${missing_sidecars[*]}"
  cargo build --release -p buzz-acp -p buzz-agent -p buzz-dev-mcp -p git-credential-nostr -p buzz-cli
fi
./scripts/bundle-sidecars.sh "${HOST}"

# 2. Capability: materialize only for this build (see header comment).
cp "${CAPABILITY_TEMPLATE}" "${CAPABILITY_ACTIVE}"

# 3. Frontend in harness mode (bundles the @wdio/tauri-plugin guest JS).
cd desktop
pnpm harness:build

# 4. The packaged app. --config merges over tauri.conf.json; beforeBuildCommand
#    is overridden so the harness frontend is the one bundled. The identifier
#    override isolates state; withGlobalTauri is required by the WDIO guest JS.
pnpm exec tauri build \
  --features wdio-harness \
  --config '{
    "identifier": "xyz.block.buzz.app.harness",
    "app": { "withGlobalTauri": true },
    "build": { "beforeBuildCommand": { "script": "pnpm harness:build", "cwd": ".." } },
    "bundle": { "targets": ["app"] }
  }' \
  --ci \
  -- --no-default-features

APP_BUNDLE="src-tauri/target/release/bundle/macos/Colony.app"
if [[ ! -d "${APP_BUNDLE}" ]]; then
  echo "[real-shell] ERROR: expected bundle not produced: ${APP_BUNDLE}" >&2
  exit 1
fi
echo "[real-shell] harness app ready: ${APP_BUNDLE}"
