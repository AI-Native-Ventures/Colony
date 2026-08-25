#!/usr/bin/env bash
set -euo pipefail

SIDECARS=(buzz-acp buzz-agent buzz-dev-mcp git-credential-nostr buzz)
HOST=$(rustc -vV | sed -n 's|host: ||p')
TARGET=${1:-$HOST}
if [[ "$TARGET" != *windows* ]]; then
    SIDECARS+=(buzz-backend-kubernetes)
    BUILD_HINT="cargo build --release -p buzz-acp -p buzz-agent -p buzz-backend-kubernetes -p buzz-dev-mcp -p git-credential-nostr -p buzz-cli"
else
    BUILD_HINT="cargo build --release -p buzz-acp -p buzz-agent -p buzz-dev-mcp -p git-credential-nostr -p buzz-cli"
fi
BINARIES_DIR="desktop/src-tauri/binaries"

# MSVC emits <name>.exe; Tauri's externalBin then expects binaries/<name>-<triple>.exe.
if [[ "$TARGET" == *windows* ]]; then
    EXE=".exe"
else
    EXE=""
fi

# Where cargo actually put the binaries. NOT hardcoded to ./target: cargo
# honours `build.target-dir` from ~/.cargo/config.toml and $CARGO_TARGET_DIR,
# and a machine that redirects them elsewhere is not exotic. The self-hosted
# macOS release runner does exactly that, to stop ~180 checkouts of this repo
# each minting their own target/ and filling the disk. When that landed, this
# script kept looking in ./target, found nothing, and failed the v0.11.1
# desktop release with "missing release binaries" — while the binaries sat
# built and correct in the shared directory. `cargo metadata` is the only
# authority on this, so ask it, and fall back to ./target only when it cannot
# be reached.
TARGET_ROOT="$(
    cargo metadata --format-version 1 --no-deps 2>/dev/null \
        | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])' 2>/dev/null \
        || true
)"
[[ -n "$TARGET_ROOT" ]] || TARGET_ROOT="target"

# When --target is passed explicitly to cargo (even if it matches the host),
# binaries land in <target-root>/<triple>/release/. Without --target, they land
# in <target-root>/release/. The script receives the target as $1 only when
# cargo was invoked with --target, so use the qualified path whenever $1 is
# set, with a fallback to the plain directory: plain `cargo build --release` on
# the host triple (the fresh-clone path) never populates the qualified
# directory, while Tauri still names the bundled sidecar with the triple.
if [[ -n "${1:-}" ]]; then
    SRC_DIR="${TARGET_ROOT}/${TARGET}/release"
    missing_in_qualified=0
    for bin in "${SIDECARS[@]}"; do
        [[ -f "${SRC_DIR}/${bin}${EXE}" ]] || missing_in_qualified=1
    done
    if [[ "${missing_in_qualified}" -eq 1 ]]; then
        plain_dir="${TARGET_ROOT}/release"
        all_in_plain=1
        for bin in "${SIDECARS[@]}"; do
            [[ -f "${plain_dir}/${bin}${EXE}" ]] || all_in_plain=0
        done
        if [[ "${all_in_plain}" -eq 1 ]]; then
            SRC_DIR="${plain_dir}"
        fi
    fi
else
    SRC_DIR="${TARGET_ROOT}/release"
fi

missing=()
for bin in "${SIDECARS[@]}"; do
    [[ -f "$SRC_DIR/${bin}${EXE}" ]] || missing+=("${bin}${EXE}")
done
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Error: missing release binaries in $SRC_DIR: ${missing[*]}" >&2
    echo "Run '$BUILD_HINT' first." >&2
    exit 1
fi

mkdir -p "$BINARIES_DIR"
for bin in "${SIDECARS[@]}"; do
    destination="$BINARIES_DIR/${bin}-${TARGET}${EXE}"
    cp "$SRC_DIR/${bin}${EXE}" "$destination"

    # cp preserves the mode of an existing destination on macOS. Generated
    # sidecar placeholders may not be executable, so make the bundled Unix
    # binaries executable explicitly.
    if [[ -z "$EXE" ]]; then
        chmod 755 "$destination"
    fi
done
echo "Sidecars bundled for $TARGET"
