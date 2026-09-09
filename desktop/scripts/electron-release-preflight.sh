#!/usr/bin/env bash
# Check presence only. Never print or materialize credential values.
set -euo pipefail
case "${COLONY_MACOS_SIGNING:-}" in
  ad-hoc|developer-id) ;;
  *) echo '::error::Select the reviewed macOS signing mode: ad-hoc or developer-id'; exit 1 ;;
esac
required=(BUZZ_UPDATER_PUBLIC_KEY TAURI_SIGNING_PRIVATE_KEY BUZZ_RELEASE_TAGGER_CLIENT_ID BUZZ_RELEASE_TAGGER_PRIVATE_KEY)
if [ "${RELEASE_MACOS:-false}" = true ] && [ "$COLONY_MACOS_SIGNING" = developer-id ]; then
  required+=(COLONY_APPLE_CERTIFICATE_P12 COLONY_APPLE_CERTIFICATE_PASSWORD COLONY_APPLE_API_KEY COLONY_APPLE_API_KEY_ID COLONY_APPLE_API_ISSUER COLONY_APPLE_SIGNING_IDENTITY COLONY_APPLE_TEAM_ID)
fi
missing=0
for key in "${required[@]}"; do
  if [ -z "${!key:-}" ]; then
    echo "::error::Production release is blocked: configure $key (see RELEASING.md)."
    missing=1
  fi
done
exit "$missing"
