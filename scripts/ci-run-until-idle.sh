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

out="$(mktemp)"
trap 'rm -f "$out"' EXIT

# The command runs in its own process group so the whole tree can be killed.
#
# Killing only the direct child is not enough and cost a full CI run to learn:
# the chain here is `sudo` -> `env` -> `apt-get`, so terminating the wrapper
# leaves apt-get alive holding /var/lib/dpkg/lock-frontend. Every later attempt
# then dies instantly with
#
#   E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process N
#
# which looks like a fast, different failure and is really the first attempt's
# corpse. setsid makes the command a group leader, so `kill -- -PID` reaches
# the wrapper and apt-get together.
#
# Output goes to a file rather than a pipe: the file's mtime is the idleness
# signal, and a file survives the kill so nothing is lost from the log.
if command -v setsid >/dev/null 2>&1; then
  setsid "$@" >"$out" 2>&1 &
elif command -v perl >/dev/null 2>&1; then
  # macOS ships no setsid. perl's setpgrp gives the same guarantee, and keeping
  # this path real means the group-kill can be exercised off CI too.
  perl -e 'setpgrp(0,0); exec @ARGV or die $!' -- "$@" >"$out" 2>&1 &
else
  "$@" >"$out" 2>&1 &
fi
worker=$!

# Stream the output live so the CI log looks the same as before.
tail -n +1 -f "$out" &
tailer=$!

mtime() {
  # GNU stat and BSD stat disagree on the flag; CI is Linux, dev machines are not.
  stat -c %Y "$out" 2>/dev/null || stat -f %m "$out" 2>/dev/null || echo 0
}

stop_tailer() {
  sleep 1
  kill "$tailer" 2>/dev/null || true
  wait "$tailer" 2>/dev/null || true
}

kill_tree() {
  # Negative pid targets the whole process group, which is the point.
  kill -TERM -- -"$worker" 2>/dev/null || kill -TERM "$worker" 2>/dev/null || true
  sleep 5
  kill -KILL -- -"$worker" 2>/dev/null || kill -KILL "$worker" 2>/dev/null || true
  wait "$worker" 2>/dev/null || true
}

while kill -0 "$worker" 2>/dev/null; do
  now="$(date +%s)"
  last="$(mtime)"
  if [ "$((now - last))" -gt "$IDLE" ]; then
    echo "::warning::no output for ${IDLE}s, killing $1 and its process group" >&2
    kill_tree
    stop_tailer
    exit 124
  fi
  sleep 5
done

wait "$worker"
rc=$?
stop_tailer
exit "$rc"
