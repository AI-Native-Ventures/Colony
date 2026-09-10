#!/usr/bin/env bash
# Build only on the disposable hosted runner. Never runs from a user's Mac.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${RUNNER_OS:-}" == macOS && "${RUNNER_ENVIRONMENT:-}" == github-hosted && "$(uname -m)" == arm64 ]] || { echo 'Hosted ARM macOS only' >&2; exit 1; }
: "${COLONY_FIXTURE_TOOLS:?Absolute tool output directory required}"
[[ "$COLONY_FIXTURE_TOOLS" == "$RUNNER_TEMP/"* ]] || exit 1
REPO=$(cd "$(dirname "$0")/../.." && pwd)
SOURCES="$REPO/desktop/src-electron/onboarding-fixture/service-sources.json"
mkdir -p "$COLONY_FIXTURE_TOOLS/bin" "$COLONY_FIXTURE_TOOLS/src"
cd "$COLONY_FIXTURE_TOOLS/src"
fetch() {
  local name=$1 url digest
  url=$(jq -r ".$name.url" "$SOURCES")
  digest=$(jq -r ".$name.sha256" "$SOURCES")
  curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 "$url" -o "$name.tar"
  printf '%s  %s\n' "$digest" "$name.tar" | shasum -a 256 --check
  tar -xf "$name.tar"
}
fetch postgres
# Core pgcrypto migration needs OpenSSL. Use the runner's native development keg.
OPENSSL_PREFIX=$(brew --prefix openssl@3)
cd "postgresql-$(jq -r .postgres.version "$SOURCES")"
CPPFLAGS="-I$OPENSSL_PREFIX/include" LDFLAGS="-L$OPENSSL_PREFIX/lib" ./configure \
  --prefix="$COLONY_FIXTURE_TOOLS/postgres" --without-icu --without-readline --with-openssl
make -j3
make install
make -C contrib/pgcrypto -j3
make -C contrib/pgcrypto install
cd "$COLONY_FIXTURE_TOOLS/src"
fetch redis
make -C "redis-$(jq -r .redis.version "$SOURCES")" -j3 MALLOC=libc
cp "redis-$(jq -r .redis.version "$SOURCES")/src/redis-server" "$COLONY_FIXTURE_TOOLS/bin/"
cp "redis-$(jq -r .redis.version "$SOURCES")/src/redis-cli" "$COLONY_FIXTURE_TOOLS/bin/"
fetch go
# Go's checksum database verifies the immutable module revision and dependencies.
GOENV=off GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org GOTOOLCHAIN=local GOBIN="$COLONY_FIXTURE_TOOLS/bin" "$COLONY_FIXTURE_TOOLS/src/go/bin/go" install \
  "github.com/minio/minio@$(jq -r .minio.revision "$SOURCES")"
cp "$SOURCES" "$COLONY_FIXTURE_TOOLS/service-sources.json"
