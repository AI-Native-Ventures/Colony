#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <deployed-version>" >&2
  exit 2
fi

expected=${1#v}
if [[ ! $expected =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "invalid deployed relay version: '$1'" >&2
  exit 2
fi

base_url=${RELAY_LIVE_BASE_URL:-https://relay.colony.ainative.ventures}
base_url=${base_url%/}
max_attempts=${RELAY_LIVE_MAX_ATTEMPTS:-30}
retry_seconds=${RELAY_LIVE_RETRY_SECONDS:-10}
curl_bin=${RELAY_LIVE_CURL:-curl}

if [[ ! $max_attempts =~ ^[1-9][0-9]*$ ]]; then
  echo "RELAY_LIVE_MAX_ATTEMPTS must be a positive integer" >&2
  exit 2
fi
if [[ ! $retry_seconds =~ ^[0-9]+$ ]]; then
  echo "RELAY_LIVE_RETRY_SECONDS must be a non-negative integer" >&2
  exit 2
fi

for ((attempt = 1; attempt <= max_attempts; attempt++)); do
  reason="readiness request failed"
  readiness=""
  if readiness=$(
    "$curl_bin" --fail --silent --show-error \
      --connect-timeout 5 --max-time 10 \
      "$base_url/_readiness" 2>/dev/null
  ); then
    if jq -e '.status == "ready"' >/dev/null 2>&1 <<<"$readiness"; then
      reason="NIP-11 request failed"
      relay_info=""
      if relay_info=$(
        "$curl_bin" --fail --silent --show-error \
          --connect-timeout 5 --max-time 10 \
          -H "Accept: application/nostr+json" \
          "$base_url/" 2>/dev/null
      ); then
        deployed=$(jq -er '.version | strings' <<<"$relay_info" 2>/dev/null || true)
        if [[ $deployed == "$expected" ]]; then
          echo "Live relay is ready and reports version $expected."
          exit 0
        fi
        if [[ -z $deployed ]]; then
          reason="NIP-11 response did not contain a string version"
        else
          reason="deployed version is '$deployed', expected '$expected'"
        fi
      fi
    else
      reason="readiness response was not ready JSON"
    fi
  fi

  if ((attempt == max_attempts)); then
    echo "live relay verification failed after $attempt attempt(s): $reason" >&2
    exit 1
  fi
  echo "Live relay attempt $attempt/$max_attempts not ready: $reason; retrying in ${retry_seconds}s."
  if ((retry_seconds > 0)); then
    sleep "$retry_seconds"
  fi
done

echo "live relay verification exhausted unexpectedly" >&2
exit 1
