#!/usr/bin/env bash
set -euo pipefail

SIDECARS=(buzz-acp buzz-agent buzz-dev-mcp git-credential-nostr buzz)
HOST=$(rustc -vV | sed -n 's|host: ||p')
TARGET=${1:-$HOST}
BINARIES_DIR="desktop/src-tauri/binaries"

# MSVC emits <name>.exe; Tauri's externalBin then expects binaries/<name>-<triple>.exe.
if [[ "$TARGET" == *windows* ]]; then
    EXE=".exe"
else
    EXE=""
fi

# When --target is passed explicitly to cargo (even if it matches the host),
# binaries land in target/<triple>/release/. Without --target, they land in
# target/release/. The script receives the target as $1 only when cargo was
# invoked with --target, so use the qualified path whenever $1 is set, with a
# fallback to target/release: plain `cargo build --release` on the host triple
# (the fresh-clone path) never populates the qualified directory, while Tauri
# still names the bundled sidecar with the triple.
if [[ -n "${1:-}" ]]; then
    SRC_DIR="target/${TARGET}/release"
    missing_in_qualified=0
    for bin in "${SIDECARS[@]}"; do
        [[ -f "${SRC_DIR}/${bin}${EXE}" ]] || missing_in_qualified=1
    done
    if [[ "${missing_in_qualified}" -eq 1 ]]; then
        plain_dir="target/release"
        all_in_plain=1
        for bin in "${SIDECARS[@]}"; do
            [[ -f "${plain_dir}/${bin}${EXE}" ]] || all_in_plain=0
        done
        if [[ "${all_in_plain}" -eq 1 ]]; then
            SRC_DIR="${plain_dir}"
        fi
    fi
else
    SRC_DIR="target/release"
fi

missing=()
for bin in "${SIDECARS[@]}"; do
    [[ -f "$SRC_DIR/${bin}${EXE}" ]] || missing+=("${bin}${EXE}")
done
if [[ ${#missing[@]} -gt 0 ]]; then
    echo "Error: missing release binaries in $SRC_DIR: ${missing[*]}" >&2
    echo "Run 'cargo build --release -p buzz-acp -p buzz-agent -p buzz-dev-mcp -p git-credential-nostr -p buzz-cli' first." >&2
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
