#!/usr/bin/env bash
# Verify actual package bytes before hosted proof or publication.
set -euo pipefail
: "${VERSION:?}" "${GITHUB_SHA:?}" "${COLONY_MACOS_SIGNING:?}"
. desktop/scripts/electron-release-channel.sh
case "$COLONY_MACOS_SIGNING" in
  ad-hoc) SIGNING='ad-hoc; not notarized' ;;
  developer-id) SIGNING='Developer ID; notarized and stapled' ;;
  *) echo '::error::Unknown macOS signing mode'; exit 1 ;;
esac
test -s "$MANIFEST"
jq -e --arg version "$VERSION" --arg sha "$GITHUB_SHA" --arg signing "$SIGNING" \
  --arg channel "$CHANNEL" --arg bundle "$APP_BUNDLE_ID" --arg exe "$APP_EXECUTABLE" '
  .version == $version and .sourceRevision == $sha and .channel == $channel and
  .profile == "release" and .arch == "arm64" and .onboardingFixture == false and
  .signing == $signing and .bundleId == $bundle and
  .executableName == $exe
' "$MANIFEST" >/dev/null
APP=$(jq -r .app "$MANIFEST")
test -d "$APP/Contents/Frameworks/Electron Framework.framework"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$VERSION"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")" = "$APP_EXECUTABLE"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = "$APP_BUNDLE_ID"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$APP/Contents/Info.plist")" = "$APP_NAME"
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
RELAY_WS_URL="${COLONY_EXPECTED_RELAY_WS_URL:-${COLONY_PRODUCTION_RELAY_WS_URL:?}}"
REQUIRED=(buzz-updater-enabled "$UPDATER_ENDPOINT" "$RELAY_WS_URL")
# The canary host must carry its own keyring service. Without it a side by side
# install reads, and fails to rewrite, the stable install's identity blob.
if [ "$CHANNEL" = canary ]; then REQUIRED+=(colony-canary-desktop); fi
if [ "$CHANNEL" = port ]; then REQUIRED+=(colony-port-desktop); fi
for required in "${REQUIRED[@]}"; do
  count=$(strings -a "$BIN" | grep -Fc "$required" || true)
  if [ "$count" -eq 0 ]; then echo "::error::Release host is missing required embedded runtime metadata: $required"; exit 1; fi
done
# A canary (or port) that still points at the stable endpoint would update
# itself into the stable app. Nothing else in the bundle reveals it.
if [ "$CHANNEL" = canary ] || [ "$CHANNEL" = port ]; then
  STABLE_ENDPOINT=https://github.com/AI-Native-Ventures/colony-releases/releases/download/colony-desktop-latest/latest.json
  if [ "$(strings -a "$BIN" | grep -Fc "$STABLE_ENDPOINT" || true)" -ne 0 ]; then
    echo "::error::The ${CHANNEL} host carries the stable updater endpoint"
    exit 1
  fi
fi
