#!/usr/bin/env bash
# Point apt away from azure.archive.ubuntu.com, for use between failed retries.
#
# Retrying against a mirror that just went silent is not a retry. GitHub's
# Azure-hosted runners point apt at azure.archive.ubuntu.com, and when a
# runner's route to that host is dead it stays dead for the whole job: on
# 2026-08-19 one smoke shard burned all three attempts against it while five
# sibling shards on healthy runners finished the same step in 15s to 156s.
#
# Ubuntu 24.04 runner images use the deb822 `ubuntu.sources` file; older images
# use the one-line `sources.list`. Both are handled because which one is
# present has changed across images.
#
# Exits 0 if it rewrote something, 1 if there was nothing left to rewrite, so
# callers can tell a first fallback from a repeat.
set -uo pipefail

# APT_ROOT exists so this can be exercised against fixture files instead of the
# runner's real /etc. Empty in CI, which is the only place it should be empty.
ROOT="${APT_ROOT:-}"

changed=0
for f in "$ROOT"/etc/apt/sources.list "$ROOT"/etc/apt/sources.list.d/*.sources \
  "$ROOT"/etc/apt/sources.list.d/*.list; do
  [ -f "$f" ] || continue
  if grep -q 'azure\.archive\.ubuntu\.com' "$f" 2>/dev/null; then
    sudo sed -i 's|azure\.archive\.ubuntu\.com|archive.ubuntu.com|g' "$f"
    echo "::warning::rewrote azure.archive.ubuntu.com to archive.ubuntu.com in $f" >&2
    changed=1
  fi
done

[ "$changed" = "1" ]
