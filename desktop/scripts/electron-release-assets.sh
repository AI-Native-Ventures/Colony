#!/usr/bin/env bash
# CI-only publication gate. Candidate/ad-hoc archives can never enter this lane.
set -euo pipefail
: "${VERSION:?}" "${GITHUB_ENV:?}" "${GITHUB_SHA:?}" "${RUNNER_TEMP:?}"
MANIFEST="desktop/electron-dist/${VERSION}-release-arm64-stable/manifest.json"
test -s "$MANIFEST"
jq -e --arg version "$VERSION" --arg sha "$GITHUB_SHA" '
  .version == $version and .sourceRevision == $sha and .channel == "stable" and
  .profile == "release" and .arch == "arm64" and .onboardingFixture == false and
  .signing == "Developer ID; notarized and stapled" and
  .bundleId == "xyz.block.buzz.app" and .executableName == "buzz-desktop"
' "$MANIFEST" >/dev/null
APP=$(jq -r .app "$MANIFEST")
test -d "$APP/Contents/Frameworks/Electron Framework.framework"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$VERSION"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")" = buzz-desktop
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = xyz.block.buzz.app
codesign --verify --deep --strict "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"
BIN="$APP/Contents/Resources/native/buzz-desktop"
for required in buzz-updater-enabled "$UPDATER_ENDPOINT" "$COLONY_PRODUCTION_RELAY_WS_URL"; do
  count=$(strings -a "$BIN" | grep -Fc "$required" || true)
  if [ "$count" -eq 0 ]; then echo "::error::Release host is missing required embedded runtime metadata: $required"; exit 1; fi
done

# Exercise the signed app with a private fixture profile. Never touch a user's
# stable account, cookie store or hosted account-creation endpoint in release QA.
COLONY_SMOKE_APP="$APP" COLONY_SMOKE_EXECUTABLE=buzz-desktop node desktop/src-electron/smoke.mjs
COLONY_SMOKE_APP="$APP" COLONY_SMOKE_EXECUTABLE=buzz-desktop node desktop/src-electron/signup-smoke.mjs

OUT="$RUNNER_TEMP/colony-production-assets"
mkdir -p "$OUT/image"
ditto "$APP" "$OUT/image/Colony.app"
ln -s /Applications "$OUT/image/Applications"
DMG="$OUT/Colony_${VERSION}_aarch64.dmg"
hdiutil create -volname Colony -srcfolder "$OUT/image" -ov -format UDZO "$DMG"
# Signing/notarization on the enclosed app is preserved by both containers.
ARCHIVE="$OUT/Colony.app.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$ARCHIVE" -C "$(dirname "$APP")" Colony.app
(cd desktop && pnpm tauri signer sign "$ARCHIVE")
test -s "$ARCHIVE.sig"
tar -tzf "$ARCHIVE" > "$OUT/archive-entries.txt"
test "$(head -1 "$OUT/archive-entries.txt")" = Colony.app/
echo "DMG=$DMG" >> "$GITHUB_ENV"
echo "ARCHIVE=$ARCHIVE" >> "$GITHUB_ENV"
echo "ARCHIVE_SIG=$ARCHIVE.sig" >> "$GITHUB_ENV"
