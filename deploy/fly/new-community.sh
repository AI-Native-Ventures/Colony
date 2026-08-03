#!/usr/bin/env bash
# Provision a new Colony community on the production relay.
#
#   deploy/fly/new-community.sh <name> <owner-pubkey-hex>
#
# Creates <name>.colony.ainative.ventures on the multi-tenant relay:
# one row in `communities` (host mapping) and an owner row in
# `relay_members`. DNS and TLS need no per-community work — the
# wildcard CNAME *.colony.ainative.ventures -> colony-relay.fly.dev and
# the Fly wildcard certificate (issued 2026-08-03) cover every name.
#
# After provisioning, join from the desktop app via "Add existing
# community" with:  wss://<name>.colony.ainative.ventures
#
# Requires: flyctl authenticated against the account owning colony-relay.

set -euo pipefail

DB_APP="colony-db-iad"
DB_NAME="colony_relay"
DOMAIN="colony.ainative.ventures"

NAME="${1:-}"
OWNER_PUBKEY="${2:-}"

if [[ -z "$NAME" || -z "$OWNER_PUBKEY" ]]; then
    echo "Usage: $0 <name> <owner-pubkey-hex>" >&2
    exit 1
fi

# Same shape Buzz enforces for hosted community slugs. The strict
# validation is also what makes interpolating into SQL below safe.
if ! [[ "$NAME" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]]; then
    echo "Error: name must be lowercase letters, numbers, and hyphens (got '$NAME')" >&2
    exit 1
fi

if ! [[ "$OWNER_PUBKEY" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Error: owner pubkey must be 64 lowercase hex chars" >&2
    exit 1
fi

HOST="${NAME}.${DOMAIN}"

SQL="DO \$\$
DECLARE cid UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM communities WHERE lower(host) = lower('${HOST}')) THEN
    RAISE EXCEPTION 'host ${HOST} is already taken';
  END IF;
  INSERT INTO communities (host) VALUES ('${HOST}') RETURNING id INTO cid;
  INSERT INTO relay_members (community_id, pubkey, role, added_by)
    VALUES (cid, '${OWNER_PUBKEY}', 'owner', 'new-community.sh');
  RAISE NOTICE 'community % created: %', cid, '${HOST}';
END
\$\$;"

# Base64 keeps the SQL intact through the two shell layers between here
# and psql (flyctl -C splits on spaces; quotes do not survive it).
SQL_B64=$(printf '%s' "$SQL" | base64 | tr -d '\n')

flyctl ssh console -a "$DB_APP" -C "sh -c 'echo ${SQL_B64} | base64 -d | PGPASSWORD=\$OPERATOR_PASSWORD psql -h localhost -U postgres -d ${DB_NAME} -v ON_ERROR_STOP=1 -f -'"

echo
echo "Community live. Join it from the app:"
echo "  Add existing community -> wss://${HOST}"
