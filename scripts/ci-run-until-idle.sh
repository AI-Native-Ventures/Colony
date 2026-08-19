#!/usr/bin/env bash
# Run a command, killing it only when it goes SILENT, not when it is merely slow.
#
# The first version of Colony's package-install guard used a total timeout, and
# that was the wrong measurement. Observed on promotion run 32250, one commit,
# one workflow, the same step:
#
#   Desktop Smoke E2E 1,2,4,6   13s to 47s   pass    healthy mirror
#   Desktop Smoke E2E 3         240s         pass    degraded, still finished
#   Desktop Smoke E2E 5         341s         FAIL    killed by a 300s cap
#   Blocks Live Gate            56s          pass    healthy mirror
#   Desktop Tauri Flags         984s         FAIL    killed by the same caps
#
# A cap set above 240s but below a genuine hang is not a cap you can pick: the
# healthy case and the hung case differ by three orders of magnitude in
# duration but are indistinguishable from duration alone at the moment you have
# to decide. What separates them is output. apt printing `Get:` lines is alive
# no matter how slow; apt silent for two minutes is the stall that ate 43
# minutes of a job on 2026-08-19 and got the run cancelled.
#
# So this watches the gap between output lines. Silence longer than the idle
# limit kills the process tree and returns 124, the same code `timeout` uses.
# Anything still talking runs to completion however long that takes.
#
# Usage: scripts/ci-run-until-idle.sh <idle_seconds> <command> [args...]
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <idle_seconds> <command> [args...]" >&2
  exit 2
fi

IDLE="$1"
shift

stamp="$(mktemp)"
trap 'rm -f "$stamp"' EXIT

# Each line of output refreshes the stamp's mtime. The subshell keeps pipefail
# so the command's status, not `read`'s, decides success.
(
  set -o pipefail
  "$@" 2>&1 | while IFS= read -r line; do
    printf '%s\n' "$line"
    : > "$stamp"
  done
) &
worker=$!

mtime() {
  # GNU stat and BSD stat disagree on the flag; CI is Linux, dev machines are not.
  stat -c %Y "$stamp" 2>/dev/null || stat -f %m "$stamp" 2>/dev/null || echo 0
}

while kill -0 "$worker" 2>/dev/null; do
  now="$(date +%s)"
  last="$(mtime)"
  if [ "$((now - last))" -gt "$IDLE" ]; then
    echo "::warning::no output for ${IDLE}s, killing $1" >&2
    pkill -P "$worker" 2>/dev/null || true
    kill -9 "$worker" 2>/dev/null || true
    wait "$worker" 2>/dev/null || true
    exit 124
  fi
  sleep 5
done

wait "$worker"
