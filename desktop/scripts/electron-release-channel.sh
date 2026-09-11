#!/usr/bin/env bash
# One place that names a channel's packaged artefacts. Sourced by the verify
# and asset scripts so a release and its proof can never disagree about which
# app they are looking at.
: "${VERSION:?}"
CHANNEL="${COLONY_RELEASE_CHANNEL:-stable}"
case "$CHANNEL" in
  stable)
    CHANNEL_SUFFIX=-stable
    APP_NAME=Colony
    APP_BUNDLE_ID=xyz.block.buzz.app
    APP_EXECUTABLE=buzz-desktop
    ASSET_PREFIX=Colony
    ;;
  canary)
    CHANNEL_SUFFIX=-canary
    APP_NAME='Colony Canary'
    APP_BUNDLE_ID=ventures.ainative.colony.canary
    # Never buzz-desktop: stable and canary must be distinguishable processes.
    APP_EXECUTABLE=colony-canary
    ASSET_PREFIX=Colony_Canary
    ;;
  *)
    echo "::error::Unknown release channel $CHANNEL"
    exit 1
    ;;
esac
MANIFEST="desktop/electron-dist/${VERSION}-release-arm64${CHANNEL_SUFFIX}/manifest.json"
