#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/build-owned-desktop.sh --relay <wss-url> [--target <triple>]

BUZZ_OWNED_RELAY_URL may be used instead of --relay.
USAGE
}

validate_relay_url() {
  node - "${1}" <<'NODE'
const { isIP } = require("node:net");
const raw = process.argv[2];
if (/[\x00-\x20\x7f]/.test(raw)) {
  process.exit(1);
}

let url;
try {
  url = new URL(raw);
} catch {
  process.exit(1);
}

const host = url.hostname
  .toLowerCase()
  .replace(/^\[/, "")
  .replace(/\]$/, "");
const labels = host.split(".");
const isDnsName =
  labels.length > 1 &&
  labels.every(
    (label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
  );
const valid =
  url.protocol === "wss:" &&
  url.username === "" &&
  url.password === "" &&
  (url.pathname === "" || url.pathname === "/") &&
  url.search === "" &&
  url.hash === "" &&
  isDnsName &&
  isIP(host) === 0 &&
  host !== "localhost" &&
  !host.endsWith(".localhost") &&
  !host.endsWith(".local");

if (!valid) {
  process.exit(1);
}

process.stdout.write(url.origin);
NODE
}

validate_target() {
  local requested_target="$1"
  local known_target
  local target_list

  if ! target_list="$(rustc --print target-list)"; then
    return 1
  fi

  while IFS= read -r known_target; do
    if [[ "${known_target}" == "${requested_target}" ]]; then
      return 0
    fi
  done <<<"${target_list}"

  return 1
}

relay_url="${BUZZ_OWNED_RELAY_URL:-}"
target=""

while (($#)); do
  case "$1" in
    --relay)
      (($# >= 2)) || {
        echo "error: --relay requires a value" >&2
        usage
        exit 2
      }
      relay_url="$2"
      shift 2
      ;;
    --target)
      (($# >= 2)) || {
        echo "error: --target requires a value" >&2
        usage
        exit 2
      }
      target="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ -z "${relay_url}" ]]; then
  echo "error: --relay or BUZZ_OWNED_RELAY_URL is required" >&2
  usage
  exit 2
fi

if ! canonical_relay_url="$(validate_relay_url "${relay_url}")"; then
  echo "error: relay must be a root-level wss:// URL on a public DNS hostname" >&2
  exit 2
fi

if [[ -z "${target}" ]]; then
  target="$(rustc -vV | awk '/^host:/ { print $2 }')"
fi
if [[ -z "${target}" ]]; then
  echo "error: could not determine the Rust host target" >&2
  exit 2
fi
if ! validate_target "${target}"; then
  echo "error: target is not recognized by rustc: ${target}" >&2
  exit 2
fi

if [[ "${BUZZ_OWNED_BUILD_DRY_RUN:-0}" == "1" ]]; then
  printf 'BUZZ_RELAY_URL=%s BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1 just desktop-release-build %s\n' \
    "${canonical_relay_url}" "${target}"
  exit 0
fi

cd "${REPO_ROOT}"
unset BUZZ_RELAY_HTTP
export BUZZ_RELAY_URL="${canonical_relay_url}"
export BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY=1
exec just desktop-release-build "${target}"
