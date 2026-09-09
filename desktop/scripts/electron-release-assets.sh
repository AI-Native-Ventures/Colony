#!/usr/bin/env bash
# CI-only publication gate. Private candidates never enter this lane.
set -euo pipefail
: "${VERSION:?}" "${GITHUB_ENV:?}" "${GITHUB_SHA:?}" "${RUNNER_TEMP:?}"
MANIFEST="desktop/electron-dist/${VERSION}-release-arm64-stable/manifest.json"
bash desktop/scripts/electron-verify-distribution.sh
APP=$(jq -r .app "$MANIFEST")

# Exercise the app with a private fixture profile. Never touch a user's
# stable account, cookie store or hosted account-creation endpoint in release QA.
COLONY_SMOKE_APP="$APP" COLONY_SMOKE_EXECUTABLE=buzz-desktop node desktop/src-electron/smoke.mjs
COLONY_SMOKE_APP="$APP" COLONY_SMOKE_EXECUTABLE=buzz-desktop node desktop/src-electron/signup-smoke.mjs

OUT="$RUNNER_TEMP/colony-production-assets"
mkdir -p "$OUT/image"
ditto "$APP" "$OUT/image/Colony.app"
ln -s /Applications "$OUT/image/Applications"
DMG="$OUT/Colony_${VERSION}_aarch64.dmg"
hdiutil create -volname Colony -srcfolder "$OUT/image" -ov -format UDZO "$DMG"
# The selected app signature is preserved by both containers. Updater signing
# remains mandatory and independent of Apple Developer signing/notarization.
ARCHIVE="$OUT/Colony.app.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" -C "$(dirname "$APP")" Colony.app
(cd desktop && pnpm tauri signer sign "$ARCHIVE")
test -s "$ARCHIVE.sig"
tar -tzf "$ARCHIVE" > "$OUT/archive-entries.txt"
test "$(head -1 "$OUT/archive-entries.txt")" = Colony.app/
echo "DMG=$DMG" >> "$GITHUB_ENV"
echo "ARCHIVE=$ARCHIVE" >> "$GITHUB_ENV"
echo "ARCHIVE_SIG=$ARCHIVE.sig" >> "$GITHUB_ENV"
