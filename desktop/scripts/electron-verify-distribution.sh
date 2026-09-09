#!/usr/bin/env bash
# Verify actual stable package bytes before hosted proof or publication.
set -euo pipefail
: "${VERSION:?}" "${GITHUB_SHA:?}" "${COLONY_MACOS_SIGNING:?}"
MANIFEST="desktop/electron-dist/${VERSION}-release-arm64-stable/manifest.json"
case "$COLONY_MACOS_SIGNING" in
  ad-hoc) SIGNING='ad-hoc; not notarized' ;;
  developer-id) SIGNING='Developer ID; notarized and stapled' ;;
  *) echo '::error::Unknown macOS signing mode'; exit 1 ;;
esac
test -s "$MANIFEST"
jq -e --arg version "$VERSION" --arg sha "$GITHUB_SHA" --arg signing "$SIGNING" '
  .version == $version and .sourceRevision == $sha and .channel == "stable" and
  .profile == "release" and .arch == "arm64" and .onboardingFixture == false and
  .signing == $signing and .bundleId == "xyz.block.buzz.app" and
  .executableName == "buzz-desktop"
' "$MANIFEST" >/dev/null
APP=$(jq -r .app "$MANIFEST")
test -d "$APP/Contents/Frameworks/Electron Framework.framework"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$VERSION"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")" = buzz-desktop
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = xyz.block.buzz.app
codesign --verify --deep --strict "$APP"
SIGNATURE=$(codesign --display --verbose=4 "$APP" 2>&1)
if [ "$COLONY_MACOS_SIGNING" = developer-id ]; then
  : "${COLONY_APPLE_TEAM_ID:?}"
  grep -Fqx "TeamIdentifier=$COLONY_APPLE_TEAM_ID" <<< "$SIGNATURE"
  grep -Fq 'Authority=Developer ID Application:' <<< "$SIGNATURE"
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
else
  grep -Fqx 'Signature=adhoc' <<< "$SIGNATURE"
fi
BIN="$APP/Contents/Resources/native/buzz-desktop"
for required in buzz-updater-enabled "$UPDATER_ENDPOINT" "$COLONY_PRODUCTION_RELAY_WS_URL"; do
  count=$(strings -a "$BIN" | grep -Fc "$required" || true)
  if [ "$count" -eq 0 ]; then echo "::error::Release host is missing required embedded runtime metadata: $required"; exit 1; fi
done
