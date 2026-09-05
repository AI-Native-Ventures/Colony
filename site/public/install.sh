#!/bin/sh
# Install the Colony CLI (`buzz` and `buzz-acp`) into ~/.local/bin.
#
# Served at https://colony.ainative.ventures/install.sh, so the usual call is:
#
#   curl -fsSL https://colony.ainative.ventures/install.sh | sh
#
# POSIX sh on purpose: this has to run under dash on a bare Linux box and
# under whatever /bin/sh a Mac has. No bashisms, no sudo, ever. Everything
# lands under $HOME.
#
# Environment overrides:
#   COLONY_CLI_VERSION   install this exact version instead of the latest
#   COLONY_INSTALL_DIR   install here instead of ~/.local/bin
#   COLONY_RELEASE_REPO  download from this repo instead of colony-releases
set -eu

REPO="${COLONY_RELEASE_REPO:-AI-Native-Ventures/colony-releases}"
ROLLING_TAG="colony-cli-latest"
INSTALL_DIR="${COLONY_INSTALL_DIR:-${HOME}/.local/bin}"

die() {
  echo "colony install: $1" >&2
  exit 1
}

note() {
  echo "colony install: $1"
}

# --- Which build do we need -------------------------------------------------

os="$(uname -s)"
arch="$(uname -m)"

case "${os}:${arch}" in
  Darwin:arm64 | Darwin:aarch64)
    target="aarch64-apple-darwin"
    ;;
  Linux:x86_64 | Linux:amd64)
    target="x86_64-unknown-linux-gnu"
    ;;
  Darwin:x86_64)
    die "Intel Macs are not built yet. Only Apple Silicon (arm64) and Linux x86_64 have builds. Build from source instead: cargo build --release -p buzz-cli -p buzz-acp"
    ;;
  Linux:aarch64 | Linux:arm64)
    die "Linux arm64 is not built yet. Only Linux x86_64 and Apple Silicon macOS have builds. Build from source instead: cargo build --release -p buzz-cli -p buzz-acp"
    ;;
  *)
    die "Unsupported platform ${os} ${arch}. Supported: macOS arm64, Linux x86_64."
    ;;
esac

if [ -n "${COLONY_CLI_VERSION:-}" ]; then
  tag="cli-v${COLONY_CLI_VERSION}"
  archive="buzz-${COLONY_CLI_VERSION}-${target}.tar.gz"
else
  tag="${ROLLING_TAG}"
  archive="buzz-${target}.tar.gz"
fi

base_url="https://github.com/${REPO}/releases/download/${tag}"

# --- Tools ------------------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  die "Need curl or wget to download, and found neither."
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v openssl >/dev/null 2>&1; then
  sha256_of() { openssl dgst -sha256 "$1" | sed 's/.*= *//'; }
else
  die "Need sha256sum, shasum, or openssl to verify the download, and found none."
fi

# --- Download and verify ----------------------------------------------------

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT INT TERM

note "downloading ${archive} from ${tag}"
fetch "${base_url}/${archive}" "${tmp}/${archive}" \
  || die "Could not download ${base_url}/${archive}. Check https://github.com/${REPO}/releases for what is published."
fetch "${base_url}/${archive}.sha256" "${tmp}/${archive}.sha256" \
  || die "Could not download the checksum ${base_url}/${archive}.sha256. Refusing to install an unverified binary."

expected="$(cut -d' ' -f1 < "${tmp}/${archive}.sha256")"
actual="$(sha256_of "${tmp}/${archive}")"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  die "Checksum mismatch for ${archive}. Expected ${expected:-<empty>}, got ${actual}. Not installing."
fi
note "checksum ok"

tar -xzf "${tmp}/${archive}" -C "$tmp" || die "Could not unpack ${archive}."

for bin in buzz buzz-acp; do
  [ -f "${tmp}/${bin}" ] || die "${archive} did not contain ${bin}."
done

# --- Install ----------------------------------------------------------------

mkdir -p "$INSTALL_DIR" || die "Could not create ${INSTALL_DIR}."

for bin in buzz buzz-acp; do
  # Install to a temp name and move into place, so a running binary is
  # replaced atomically rather than truncated under its own feet.
  cp "${tmp}/${bin}" "${INSTALL_DIR}/.${bin}.new" || die "Could not write to ${INSTALL_DIR}. This installer never uses sudo; set COLONY_INSTALL_DIR to somewhere you own."
  chmod 755 "${INSTALL_DIR}/.${bin}.new"
  mv -f "${INSTALL_DIR}/.${bin}.new" "${INSTALL_DIR}/${bin}"
done

# `colony` is the name people reach for; it is the same binary as `buzz`.
ln -sf buzz "${INSTALL_DIR}/colony"

note "installed buzz, buzz-acp and colony into ${INSTALL_DIR}"

# Smoke check. `buzz` has no --version flag today, so --help is the cheapest
# proof the binary actually runs on this machine rather than dying on a
# missing library or the wrong architecture.
if ! "${INSTALL_DIR}/buzz" --help >/dev/null 2>&1; then
  note "warning: ${INSTALL_DIR}/buzz would not run. It may be built for a different architecture."
fi

# --- PATH -------------------------------------------------------------------

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*)
    note "done. Try: buzz --help"
    ;;
  *)
    echo
    note "${INSTALL_DIR} is not on your PATH. Add this line to your shell profile (~/.zshrc or ~/.bashrc):"
    echo
    echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo
    note "then open a new shell and run: buzz --help"
    ;;
esac
