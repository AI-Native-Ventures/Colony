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
# fails, not on one that goes quiet mid-transfer. So the wall clock has to be
# the thing that gives up, which means an external `timeout` around apt.
#
# Usage: scripts/ci-apt-install.sh <package>...
set -euo pipefail

ATTEMPTS="${CI_APT_ATTEMPTS:-3}"
UPDATE_TIMEOUT="${CI_APT_UPDATE_TIMEOUT:-120}"
INSTALL_TIMEOUT="${CI_APT_INSTALL_TIMEOUT:-300}"
RETRY_DELAY="${CI_APT_RETRY_DELAY:-15}"

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
  local limit="$1"
  shift
  sudo env DEBIAN_FRONTEND=noninteractive \
    timeout --kill-after=30 "$limit" \
    apt-get "$@" "${apt_opts[@]}"
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  if run_apt "$UPDATE_TIMEOUT" update &&
    run_apt "$INSTALL_TIMEOUT" install -y --no-install-recommends "$@"; then
    exit 0
  fi
  echo "::warning::apt attempt ${attempt}/${ATTEMPTS} failed (update limit ${UPDATE_TIMEOUT}s, install limit ${INSTALL_TIMEOUT}s)" >&2
  if [ "$attempt" -lt "$ATTEMPTS" ]; then
    sleep "$RETRY_DELAY"
  fi
done

echo "apt failed after ${ATTEMPTS} attempts" >&2
exit 1
