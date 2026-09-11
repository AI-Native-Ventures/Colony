#!/usr/bin/env bash
# CI-only publication gate. Private candidates never enter this lane.
set -euo pipefail
: "${VERSION:?}" "${GITHUB_ENV:?}" "${GITHUB_SHA:?}" "${RUNNER_TEMP:?}"
. desktop/scripts/electron-release-channel.sh
bash desktop/scripts/electron-verify-distribution.sh
APP=$(jq -r .app "$MANIFEST")

# Exercise the app with a private fixture profile. Never touch a user's
# stable account, cookie store or hosted account-creation endpoint in release QA.
COLONY_SMOKE_APP="$APP" COLONY_SMOKE_EXECUTABLE="$APP_EXECUTABLE" node desktop/src-electron/smoke.mjs
COLONY_SMOKE_APP="$APP" COLONY_SMOKE_EXECUTABLE="$APP_EXECUTABLE" node desktop/src-electron/signup-smoke.mjs

OUT="$RUNNER_TEMP/colony-production-assets"
rm -rf "$OUT"
mkdir -p "$OUT/image"
ditto "$APP" "$OUT/image/${APP_NAME}.app"
ln -s /Applications "$OUT/image/Applications"
DMG="$OUT/${ASSET_PREFIX}_${VERSION}_aarch64.dmg"
hdiutil create -volname "$APP_NAME" -srcfolder "$OUT/image" -ov -format UDZO "$DMG"
# The selected app signature is preserved by both containers. Updater signing
# remains mandatory and independent of Apple Developer signing/notarization.
ARCHIVE="$OUT/${ASSET_PREFIX}.app.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" -C "$(dirname "$APP")" "${APP_NAME}.app"
(cd desktop && pnpm tauri signer sign "$ARCHIVE")
test -s "$ARCHIVE.sig"
tar -tzf "$ARCHIVE" > "$OUT/archive-entries.txt"
test "$(head -1 "$OUT/archive-entries.txt")" = "${APP_NAME}.app/"
echo "DMG=$DMG" >> "$GITHUB_ENV"
echo "ARCHIVE=$ARCHIVE" >> "$GITHUB_ENV"
echo "ARCHIVE_SIG=$ARCHIVE.sig" >> "$GITHUB_ENV"
