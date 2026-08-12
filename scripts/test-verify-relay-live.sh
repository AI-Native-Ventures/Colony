#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
verify="$repo_root/scripts/verify-relay-live.sh"

if [[ ! -x $verify ]]; then
  echo "live relay canary is missing or not executable: $verify" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

mock_curl="$tmp/mock-curl"
cat >"$mock_curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"$MOCK_CURL_LOG"
url=${!#}

if [[ $url == */_readiness ]]; then
  count=0
  if [[ -f $MOCK_CURL_STATE ]]; then
    count=$(cat "$MOCK_CURL_STATE")
  fi
  count=$((count + 1))
  printf '%s' "$count" >"$MOCK_CURL_STATE"
  case "$MOCK_SCENARIO" in
    never-ready) printf '%s\n' '{"status":"starting"}' ;;
    retry-success)
      if [[ $count -eq 1 ]]; then
        printf '%s\n' '{"status":"starting"}'
      else
        printf '%s\n' '{"status":"ready"}'
      fi
      ;;
    *) printf '%s\n' '{"status":"ready"}' ;;
  esac
  exit 0
fi

case "$MOCK_SCENARIO" in
  wrong-version) printf '%s\n' '{"version":"9.9.9"}' ;;
  *) printf '%s\n' '{"version":"0.8.1"}' ;;
esac
MOCK
chmod +x "$mock_curl"

run_verify() {
  local scenario=$1 tag=$2 attempts=${3:-2}
  : >"$tmp/curl.log"
  rm -f "$tmp/state"
  MOCK_SCENARIO="$scenario" \
  MOCK_CURL_LOG="$tmp/curl.log" \
  MOCK_CURL_STATE="$tmp/state" \
  RELAY_LIVE_CURL="$mock_curl" \
  RELAY_LIVE_BASE_URL="https://relay.example.test" \
  RELAY_LIVE_MAX_ATTEMPTS="$attempts" \
  RELAY_LIVE_RETRY_SECONDS=0 \
    "$verify" "$tag"
}

if run_verify never-ready 0.8.1 2; then
  echo "canary accepted a relay that never became ready" >&2
  exit 1
fi

if run_verify wrong-version 0.8.1 2; then
  echo "canary accepted the wrong deployed version" >&2
  exit 1
fi

run_verify retry-success v0.8.1 2
[[ $(cat "$tmp/state") == 2 ]] || {
  echo "canary did not retry readiness before succeeding" >&2
  exit 1
}
grep -Fq -- '-H Accept: application/nostr+json' "$tmp/curl.log" || {
  echo "canary did not request NIP-11 relay information" >&2
  exit 1
}

run_verify success 0.8.1 1
[[ $(cat "$tmp/state") == 1 ]] || {
  echo "canary retried after immediate success" >&2
  exit 1
}

if run_verify success relay-v0.8.1 1; then
  echo "canary accepted a non-deployment tag shape" >&2
  exit 1
fi

echo "live relay canary tests passed"
