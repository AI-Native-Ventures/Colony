#!/usr/bin/env bash
# Install apt packages on a CI runner, surviving a stalled Ubuntu mirror.
#
# Colony lost a promotion run on 2026-08-19 when five jobs sat inside
# `apt-get update` for 43 minutes with no output and were killed by the
# 45-minute job timeout (run 32227945283, attempts 1 and 2). The runner's
# azure.archive.ubuntu.com mirror answered `Ign:` on every line, apt fell back
# to archive.ubuntu.com over https, and the transfer stalled after
# `Get:5 ... noble-security InRelease`.
#
# apt's own knobs did not help and are kept below only for the cases they do
# cover: `Acquire::Retries` and `Acquire::*::Timeout` act on a connection that
# fails, not on one that goes quiet mid-transfer.
#
# The first fix here used a total `timeout` per apt call, and that measured the
# wrong thing. On one later run the same step took 13s to 47s on four healthy
# runners, 240s on a degraded one that still finished, and was killed at 300s
# on another. Duration alone cannot separate "slow" from "hung" when the
# healthy spread is that wide; output can. See scripts/ci-run-until-idle.sh,
# which kills only after a stretch of total silence.
#
# Usage: scripts/ci-apt-install.sh <package>...
set -euo pipefail

ATTEMPTS="${CI_APT_ATTEMPTS:-3}"
# Silence, not duration. apt prints a line per package fetched, so two minutes
# without one means the transfer is dead rather than merely slow.
IDLE_LIMIT="${CI_APT_IDLE_LIMIT:-120}"
RETRY_DELAY="${CI_APT_RETRY_DELAY:-15}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <package>..." >&2
  exit 1
fi

apt_opts=(
  -o Acquire::Retries=3
  -o Acquire::http::Timeout=30
  -o Acquire::https::Timeout=30
  -o DPkg::Lock::Timeout=120
)

run_apt() {
  "$HERE/ci-run-until-idle.sh" "$IDLE_LIMIT" \
    sudo env DEBIAN_FRONTEND=noninteractive apt-get "$@" "${apt_opts[@]}"
}


for attempt in $(seq 1 "$ATTEMPTS"); do
  if run_apt update && run_apt install -y --no-install-recommends "$@"; then
    exit 0
  fi
  echo "::warning::apt attempt ${attempt}/${ATTEMPTS} failed (idle limit ${IDLE_LIMIT}s)" >&2
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    # Only useful once; after the first rewrite there is no azure entry left.
    "$HERE/ci-drop-azure-mirror.sh" || true
    sleep "$RETRY_DELAY"
  fi
done

echo "apt failed after ${ATTEMPTS} attempts" >&2
exit 1
