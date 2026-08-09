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

# An explicitly exported variable outranks .env.
#
# `set -o allexport; source .env` overwrites variables the caller deliberately
# set, which is the opposite of what every caller expects. It matters here
# because this script decides which database gets seeded and under which host:
# a launcher pointing at an isolated stack (PGPORT=5555, RELAY_URL on a private
# port) would otherwise silently seed the SHARED dev database on 5432, and put
# the community under the wrong host.
_pre_PGHOST="${PGHOST:-}"
_pre_PGPORT="${PGPORT:-}"
_pre_PGUSER="${PGUSER:-}"
_pre_PGPASSWORD="${PGPASSWORD:-}"
_pre_PGDATABASE="${PGDATABASE:-}"
_pre_RELAY_URL="${RELAY_URL:-}"

if [[ -f ".env" ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source .env
  set +o allexport
fi

[[ -n "${_pre_PGHOST}" ]] && export PGHOST="${_pre_PGHOST}"
[[ -n "${_pre_PGPORT}" ]] && export PGPORT="${_pre_PGPORT}"
[[ -n "${_pre_PGUSER}" ]] && export PGUSER="${_pre_PGUSER}"
[[ -n "${_pre_PGPASSWORD}" ]] && export PGPASSWORD="${_pre_PGPASSWORD}"
[[ -n "${_pre_PGDATABASE}" ]] && export PGDATABASE="${_pre_PGDATABASE}"
[[ -n "${_pre_RELAY_URL}" ]] && export RELAY_URL="${_pre_RELAY_URL}"
unset _pre_PGHOST _pre_PGPORT _pre_PGUSER _pre_PGPASSWORD _pre_PGDATABASE _pre_RELAY_URL

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

# Loopback gets exactly ONE community, spelled the way every other component
# canonicalises it.
#
# This used to seed `localhost`, `127.0.0.1`, and both with the port, to dodge a
# fail-closed 404 when one side used a different spelling. Under row-zero host
# binding those are four DISTINCT communities with four ids, so the effect was
# the opposite of the intent: state split across tenants depending on how the
# address happened to be spelled, and it was silent. It broke managed agents
# outright, because `buzz_core::relay::normalize_relay_url` canonicalises every
# loopback spelling to 127.0.0.1 before the desktop injects BUZZ_RELAY_URL,
# while a user who typed `localhost` was bound to a different community.
#
# Aliasing at lookup time is not the fix: `verify_nip98_event` deliberately
# refuses to collapse loopback spellings (see the "No loopback aliasing" note in
# buzz-auth/src/nip98.rs), because the `u`-tag host IS the community binding.
# So we remove the split at the source instead: one canonical row.
if host in {"localhost", "127.0.0.1", "::1"}:
    hosts = [authority("127.0.0.1", port, scheme)]

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

# The canonical authority alone, as a bare string, for the fold below.
primary_host=$(python3 - <<'MARK'
import os
from urllib.parse import urlparse

relay_url = os.environ.get("RELAY_URL", "ws://localhost:3000")
parsed = urlparse(relay_url)
host = (parsed.hostname or "").rstrip(".").lower()
port = parsed.port
scheme = parsed.scheme.lower()
if host in {"localhost", "127.0.0.1", "::1"}:
    host = "127.0.0.1"
default_port = (scheme == "ws" and port == 80) or (scheme == "wss" and port == 443)
display = f"[{host}]" if ":" in host and not host.startswith("[") else host
print(f"{display}:{port}" if port and not default_port else display)
MARK
)

# Loopback alias spellings this deployment's canonical host may have been
# seeded under before. Empty for a non-loopback deployment, which never had
# aliases to fold.
case "${primary_host}" in
  127.0.0.1*)
    alias_port="${primary_host#127.0.0.1}"
    fold_candidates="'localhost', '127.0.0.1', '[::1]', 'localhost${alias_port}', '[::1]${alias_port}'"
    ;;
  *)
    fold_candidates="''"
    ;;
esac

# Fold a pre-existing loopback community onto the canonical spelling before
# inserting, so a dev database seeded by the old alias behaviour keeps its
# channels, members, and events instead of appearing empty under the canonical
# host. The community id never changes, so every scoped row follows it.
#
# Deliberately conservative: it renames at most one row, and only when the
# canonical row does not already exist. A database that already has BOTH
# spellings is genuinely split, and merging two communities is a data migration,
# not something a seed script should attempt silently.
fold_sql="
UPDATE communities
SET host = '${primary_host}'
WHERE id = (
  SELECT id FROM communities
  WHERE lower(host) <> lower('${primary_host}')
    AND lower(host) IN (${fold_candidates})
  ORDER BY created_at
  LIMIT 1
)
AND NOT EXISTS (
  SELECT 1 FROM communities WHERE lower(host) = lower('${primary_host}')
);
"

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

# Fold before insert. Renaming a legacy loopback alias has to happen while
# the canonical row still does not exist, or the NOT EXISTS guard declines
# and the old community stays stranded under a host nothing resolves to.
run_psql -c "${fold_sql}"
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
