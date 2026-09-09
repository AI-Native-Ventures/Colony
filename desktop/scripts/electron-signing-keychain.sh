#!/usr/bin/env bash
# CI-only ephemeral Developer ID credentials. Never touches the login keychain.
set -euo pipefail
: "${RUNNER_TEMP:?GitHub runner temporary directory is required}"
KEYCHAIN="$RUNNER_TEMP/colony-release.keychain-db"
CERTIFICATE="$RUNNER_TEMP/colony-release.p12"
API_KEY="$RUNNER_TEMP/colony-notary.p8"
case "${1:-}" in
  install)
    : "${GITHUB_ENV:?}" "${COLONY_APPLE_CERTIFICATE_P12:?}" "${COLONY_APPLE_CERTIFICATE_PASSWORD:?}" "${COLONY_APPLE_API_KEY_CONTENT:?}"
    umask 077
    printf '%s' "$COLONY_APPLE_CERTIFICATE_P12" | base64 --decode > "$CERTIFICATE"
    printf '%s' "$COLONY_APPLE_API_KEY_CONTENT" > "$API_KEY"
    PASSWORD=$(openssl rand -hex 32)
    echo "::add-mask::$PASSWORD"
    security create-keychain -p "$PASSWORD" "$KEYCHAIN"
    security set-keychain-settings -lut 21600 "$KEYCHAIN"
    security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"
    security import "$CERTIFICATE" -P "$COLONY_APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security -t cert -f pkcs12 -k "$KEYCHAIN"
    security set-key-partition-list -S apple-tool:,apple:,codesign: -k "$PASSWORD" "$KEYCHAIN"
    # Preserve system roots and existing runner search paths for notarization.
    security list-keychains -d user -s "$KEYCHAIN" "$HOME/Library/Keychains/login.keychain-db"
    rm -f "$CERTIFICATE"
    echo "COLONY_APPLE_KEYCHAIN=$KEYCHAIN" >> "$GITHUB_ENV"
    echo "COLONY_APPLE_API_KEY=$API_KEY" >> "$GITHUB_ENV"
    ;;
  cleanup)
    security delete-keychain "$KEYCHAIN" 2>/dev/null || true
    rm -f "$CERTIFICATE" "$API_KEY"
    ;;
  *) echo "Usage: electron-signing-keychain.sh install|cleanup" >&2; exit 2 ;;
esac
