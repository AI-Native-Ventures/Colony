#!/usr/bin/env bash
set -euo pipefail

# The sherpa-onnx build script downloads this release archive with a single
# ureq request. Fetch it here with retries and a cacheable, atomically-written
# path so a transient GitHub CDN EOF cannot fail an otherwise healthy Tauri job.
case "$(uname -s):$(uname -m)" in
  Linux:x86_64) ;;
  *)
    echo "Skipping sherpa-onnx Linux archive preparation on $(uname -s)/$(uname -m)."
    exit 0
    ;;
esac

lockfile="${SHERPA_ONNX_LOCKFILE:-desktop/src-tauri/Cargo.lock}"
cache_dir="${SHERPA_ONNX_CACHE_DIR:-${GITHUB_WORKSPACE:-${PWD}}/.cache/sherpa-onnx}"

if [[ ! -f "${lockfile}" ]]; then
  echo "::error::Cannot find sherpa-onnx lockfile: ${lockfile}" >&2
  exit 1
fi

version="$(awk '
  /^\[\[package\]\]$/ { in_package = 0 }
  $0 == "name = \"sherpa-onnx-sys\"" { in_package = 1; next }
  in_package && /^version = / { gsub(/\"/, "", $3); print $3; exit }
' "${lockfile}")"
if [[ -z "${version}" ]]; then
  echo "::error::Could not determine sherpa-onnx-sys version from ${lockfile}" >&2
  exit 1
fi

archive="sherpa-onnx-v${version}-linux-x64-static-lib.tar.bz2"
url="https://github.com/k2-fsa/sherpa-onnx/releases/download/v${version}/${archive}"
mkdir -p "${cache_dir}"
archive_path="${cache_dir}/${archive}"

valid_archive() {
  [[ -s "$1" ]] && tar -tjf "$1" >/dev/null 2>&1
}

if ! valid_archive "${archive_path}"; then
  rm -f "${archive_path}"
  for attempt in 1 2 3; do
    partial="${archive_path}.part"
    rm -f "${partial}"
    echo "Downloading ${archive} (attempt ${attempt}/3)..."
    if curl --fail --location --show-error \
      --retry 5 --retry-all-errors --retry-delay 3 \
      --connect-timeout 30 --max-time 600 \
      "${url}" --output "${partial}" && valid_archive "${partial}"; then
      mv "${partial}" "${archive_path}"
      break
    fi
    rm -f "${partial}"
    if [[ "${attempt}" -eq 3 ]]; then
      echo "::error::Unable to download a valid sherpa-onnx archive after 3 attempts: ${url}" >&2
      exit 1
    fi
    sleep $((attempt * 5))
  done
else
  echo "Reusing cached ${archive}."
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'SHERPA_ONNX_ARCHIVE_DIR=%s\n' "${cache_dir}" >> "${GITHUB_ENV}"
else
  echo "SHERPA_ONNX_ARCHIVE_DIR=${cache_dir}"
fi
