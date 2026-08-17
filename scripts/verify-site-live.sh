#!/usr/bin/env bash
# Proves the custom domain is serving the build that was just deployed, not a
# cached older one. A `wrangler pages deploy` that exits 0 only proves upload
# succeeded; it says nothing about what colony.ainative.ventures returns. The
# whole reason this workflow exists is that main and production drifted
# silently for 17 hours, so "deployed" has to mean "verified live", not
# "the command exited 0".
#
# Usage: verify-site-live.sh <site-url> <dist-dir>
set -euo pipefail

SITE_URL="${1:?usage: verify-site-live.sh <site-url> <dist-dir>}"
DIST_DIR="${2:?usage: verify-site-live.sh <site-url> <dist-dir>}"

SITE_URL="${SITE_URL%/}"

# Vite fingerprints the entry bundle, so its filename is a content hash of the
# exact build that just went out. If the live HTML names the same file, the
# live site is that build.
expected_entry="$(grep -o '/assets/index-[A-Za-z0-9_-]*\.js' "${DIST_DIR}/index.html" | head -n 1)"
if [[ -z "${expected_entry}" ]]; then
  echo "::error::No hashed entry bundle found in ${DIST_DIR}/index.html; the build output is not the shape this check expects." >&2
  exit 1
fi
echo "Expecting the live site to serve ${expected_entry}"

# Cloudflare Pages promotes a production deploy in seconds, but the custom
# domain sits behind the zone edge, so allow a short propagation window rather
# than failing the first time round.
served=""
for attempt in $(seq 1 12); do
  # Cache-buster plus no-cache: the zone edge is exactly what could hand back a
  # stale document and make this check pass on the previous deploy.
  served="$(curl -fsS --max-time 20 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "${SITE_URL}/?cachebust=${GITHUB_RUN_ID:-local}-${attempt}" || true)"

  if [[ "${served}" == *"${expected_entry}"* ]]; then
    echo "Live site is serving ${expected_entry} (attempt ${attempt})"
    break
  fi

  if [[ "${attempt}" -eq 12 ]]; then
    echo "::error::${SITE_URL} is still not serving ${expected_entry} after 12 attempts. The deploy uploaded but production is serving something else." >&2
    echo "Live HTML asset references were:" >&2
    printf '%s\n' "${served}" | grep -o '/assets/[A-Za-z0-9_.-]*' >&2 || echo "(none found)" >&2
    exit 1
  fi

  echo "Attempt ${attempt}: not live yet, retrying in 10s"
  sleep 10
done

# Both are referenced by root-absolute path from index.html, so a missing file
# 404s in production while the build itself still succeeds. That failure is
# invisible unless something asks for them by name.
for path in "${expected_entry}" /favicon.svg /og.png; do
  code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 20 "${SITE_URL}${path}" || true)"
  if [[ "${code}" != "200" ]]; then
    echo "::error::${SITE_URL}${path} returned ${code:-no response}, expected 200." >&2
    exit 1
  fi
  echo "${path} -> 200"
done

echo "Live site verified at ${SITE_URL}"
