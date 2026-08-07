#!/usr/bin/env bash
set -euo pipefail

# Build the Tauri updater manifest for THIS release while carrying over the
# other platforms' entries from the manifest already served at
# <existing-manifest-url>. The desktop app polls one fixed latest.json whose
# single top-level `version` field is shared by every platform, so platform
# jobs can publish independently (Mac must not wait for a cold Windows build)
# as long as every entry in the manifest is for the same version.
#
# Preservation rule: an existing entry is carried over only when its archive
# URL embeds the SAME version as this run (Colony_<version>_<arch>.*). Entries
# for any other version are dropped — a stale entry would make that platform's
# clients see a spurious update to the archive they already have. Entries for
# a platform this run is itself publishing are never carried over, so the
# freshly built artifact always wins.
#
# Usage: merge-latest-json.sh <version> <existing-manifest-url|-> <output-file> \
#         <platform-key:sig-file:archive-url> [...]

if [[ $# -lt 3 ]]; then
  echo "Usage: merge-latest-json.sh <version> <existing-manifest-url|-> <output-file> <platform-key:sig-file:url>..." >&2
  exit 1
fi

VERSION="$1"
EXISTING_URL="$2"
OUT="$3"
shift 3

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TRIPLES=("$@")

MY_KEYS=()
for triple in "${TRIPLES[@]}"; do
  MY_KEYS+=("${triple%%:*}")
done

is_mine() {
  local key
  for key in "${MY_KEYS[@]}"; do
    [[ "$key" == "$1" ]] && return 0
  done
  return 1
}

SIG_FILES=()
cleanup() {
  if [[ ${#SIG_FILES[@]} -gt 0 ]]; then
    rm -f "${SIG_FILES[@]}"
  fi
}
trap cleanup EXIT

# Pull the manifest currently being served so its other-platform entries can
# be carried into the new one. A 404 (first release) or any fetch failure
# means there is nothing to preserve.
EXISTING=""
if [[ "$EXISTING_URL" != "-" ]]; then
  EXISTING=$(curl -fsSL "$EXISTING_URL" 2>/dev/null || true)
fi

if [[ -n "$EXISTING" ]] && printf '%s' "$EXISTING" | jq -e '.platforms' >/dev/null 2>&1; then
  for key in $(printf '%s' "$EXISTING" | jq -r '.platforms | keys[]'); do
    if is_mine "$key"; then
      continue
    fi
    sig=$(printf '%s' "$EXISTING" | jq -r --arg k "$key" '.platforms[$k].signature')
    url=$(printf '%s' "$EXISTING" | jq -r --arg k "$key" '.platforms[$k].url')
    entry_ver=$(basename "$url" | sed -n 's/^Colony_\([^_]*\)_.*/\1/p')
    if [[ -z "$entry_ver" || "$entry_ver" != "$VERSION" ]]; then
      echo "merge-latest-json: dropping ${key} entry at v${entry_ver:-<unknown>} (this release is v${VERSION})" >&2
      continue
    fi
    sig_file=$(mktemp)
    printf '%s' "$sig" > "$sig_file"
    SIG_FILES+=("$sig_file")
    TRIPLES+=("${key}:${sig_file}:${url}")
    echo "merge-latest-json: carrying over ${key} entry at v${entry_ver}" >&2
  done
fi

"$SCRIPT_DIR/generate-oss-latest-json.sh" "$VERSION" "${TRIPLES[@]}" > "$OUT"
