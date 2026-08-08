#!/usr/bin/env bash
# Seed local dev host -> community rows for row-zero host binding.
#
# The relay intentionally fails closed when the request Host header is not in
# `communities`. Local dev uses loopback hosts, so bootstrap must create those
# rows after migrations before desktop/Tauri HTTP bridge calls can succeed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

if [[ -f ".env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
fi

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-buzz}"
export PGPASSWORD="${PGPASSWORD:-buzz_dev}"
export PGDATABASE="${PGDATABASE:-buzz}"
export RELAY_URL="${RELAY_URL:-ws://localhost:3000}"

hosts_sql=$(python3 - <<'PY'
import os
from urllib.parse import urlparse

relay_url = os.environ.get("RELAY_URL", "ws://localhost:3000")
parsed = urlparse(relay_url)

host = (parsed.hostname or "").rstrip(".").lower()
port = parsed.port
scheme = parsed.scheme.lower()

def authority(host, port, scheme):
    if not host:
        return ""
    display_host = f"[{host}]" if ":" in host and not host.startswith("[") else host
    default_port = (scheme == "ws" and port == 80) or (scheme == "wss" and port == 443)
    if port and not default_port:
        return f"{display_host}:{port}"
    return display_host

primary = authority(host, port, scheme)
hosts = []
if primary:
    hosts.append(primary)

# Local desktop/dev tooling has historically used both localhost and 127.0.0.1,
# and some HTTP clients can omit the default/non-default port in Host handling.
# Under row-zero host binding these are distinct hosts, so seed loopback aliases
# for local dev to avoid a fail-closed 404 when one side uses an alternate
# authority. Non-loopback deployments seed only RELAY_URL's authority.
if host in {"localhost", "127.0.0.1"}:
    hosts.extend(["localhost", "127.0.0.1"])
    if port:
        hosts.extend([f"localhost:{port}", f"127.0.0.1:{port}"])

seen = []
for h in hosts:
    if h and h not in seen:
        seen.append(h)

if not seen:
    raise SystemExit("could not derive a host from RELAY_URL")

lines = []
for h in seen:
    escaped = h.replace(chr(39), chr(39) * 2)
    lines.append(f"    ('{escaped}')")
print(",\n".join(lines))
PY
)

# Every path that creates a community in the product writes an `owner`
# relay-membership row in the same transaction that creates it
# (`Db::create_community_with_owner`, `handlers::community_provisioning`).
# This script was the one exception, so a local dev community came up with
# members and no owner, permanently.
#
# That is the top rung of the interrupt ladder. Without it
# `interrupt_runtime::find_unique_owner` returns `None`, so an ask that
# climbed all the way to the executive can never be filed to a human -- the
# sweep re-deadlines it forever, and the surface that shows an owner what
# needs them is empty by construction rather than because nothing needs them.
# `buzz-relay` logs that as a warning only when an ask actually comes due,
# which is long after the state was created.
#
# So the owner pubkey is asked for, and its absence is stated rather than
# silently reproducing the old shape.
OWNER_PUBKEY="${OWNER_PUBKEY:-${1:-}}"
OWNER_PUBKEY="$(printf '%s' "${OWNER_PUBKEY}" | tr '[:upper:]' '[:lower:]')"

if [[ -n "${OWNER_PUBKEY}" && ! "${OWNER_PUBKEY}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "error: OWNER_PUBKEY must be 64 hex characters, got '${OWNER_PUBKEY}'" >&2
  exit 1
fi

sql="
INSERT INTO communities (host)
SELECT host
FROM (VALUES
${hosts_sql}
) AS v(host)
ON CONFLICT (lower(host)) DO NOTHING;
"

if [[ -n "${OWNER_PUBKEY}" ]]; then
  # Scoped to the hosts this run seeds, so it can never promote a pubkey in
  # a community this script does not own. Existing owners are left alone:
  # ownership transfer is `Db::transfer_ownership`'s job, and a dev-seed
  # script silently demoting a real owner is not a trade worth making.
  sql="${sql}
INSERT INTO relay_members (community_id, pubkey, role, added_by)
SELECT c.id, '${OWNER_PUBKEY}', 'owner', NULL
FROM communities c
WHERE lower(c.host) IN (
  SELECT lower(host) FROM (VALUES
${hosts_sql}
  ) AS v(host)
)
ON CONFLICT (community_id, pubkey) DO UPDATE SET role = 'owner', updated_at = now();
"
fi

run_psql() {
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="${PGPASSWORD}" psql -h "${PGHOST}" -p "${PGPORT}" -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 "$@"
  elif docker exec buzz-postgres psql --version >/dev/null 2>&1; then
    docker exec -i -e PGPASSWORD="${PGPASSWORD}" buzz-postgres \
      psql -U "${PGUSER}" -d "${PGDATABASE}" -v ON_ERROR_STOP=1 "$@"
  else
    echo "error: neither psql nor buzz-postgres docker psql is available" >&2
    exit 1
  fi
}

run_psql -c "${sql}"

echo "Seeded local dev community host(s):"
echo "${hosts_sql}" | sed -E "s/^ +\('(.+)'\),?$/  - \1/"

[[ -n "${OWNER_PUBKEY}" ]] && echo "Community owner: ${OWNER_PUBKEY}"

# Both ends of "exactly one" are reported, not just the empty one.
# `interrupt_runtime::find_unique_owner` never guesses between co-owners, so
# two owners re-deadlines an executive's ask exactly as zero owners does. This
# script leaves an existing owner alone rather than demoting it (ownership
# transfer is `Db::transfer_ownership`'s job), so running it twice with two
# different pubkeys is a real way to land there.
owner_counts=$(run_psql -tAc "
  SELECT c.host || '=' || count(m.*)
  FROM communities c
  LEFT JOIN relay_members m ON m.community_id = c.id AND m.role = 'owner'
  WHERE lower(c.host) IN (
    SELECT lower(host) FROM (VALUES
${hosts_sql}
    ) AS v(host)
  )
  GROUP BY c.host
  HAVING count(m.*) <> 1;
")

if [[ -n "$(printf '%s' "${owner_counts}" | tr -d '[:space:]')" ]]; then
  cat >&2 <<EOF

warning: these hosts do not have exactly one owner (host=owners):
$(printf '%s' "${owner_counts}" | sed 's/^/  /')

  Nothing reaches a human through the interrupt ladder in this state. The
  relay never guesses which of several owners a decision belongs in front of,
  so zero owners and two owners both leave an executive's ask re-deadlined
  indefinitely instead of in front of anyone.

  Zero: re-run with the pubkey you sign as in the desktop app or the CLI.

    OWNER_PUBKEY=<64-hex> ./scripts/seed-local-community.sh

  More than one: pick the real one with buzz-admin; this script will not
  demote an existing owner.

EOF
fi
