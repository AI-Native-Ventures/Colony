#!/usr/bin/env bash
# Nuke and reseed the Colony CANARY relay's database.
#
#   scripts/canary-reset.sh [--yes]
#
# Stops the canary relay machine, drops and recreates its Postgres database,
# starts the machine again, and waits for the relay to rebuild the schema
# (fly.canary.toml sets BUZZ_AUTO_MIGRATE=true) and report ready.
#
# This DESTROYS every event, community, membership, and message on the
# canary. It leaves the app, the volume, the Tigris bucket, and every Fly
# secret alone - including BUZZ_RELAY_PRIVATE_KEY, so the canary keeps its
# relay identity across a wipe.
#
# It refuses to run against any app whose name is not exactly
# colony-relay-canary. There is no flag to override that.
#
# Requires: flyctl authenticated against the account owning the canary, and
# curl for the readiness probe.

set -euo pipefail

# ---------------------------------------------------------------- constants
RELAY_APP="colony-relay-canary"
DB_APP="colony-db-canary-iad"
DB_NAME="colony_relay"
DB_USER="colony_relay_canary"
RELAY_HOST="relay-canary.colony.ainative.ventures"

READY_TIMEOUT_SECS=180
READY_POLL_SECS=5

die() { printf 'Error: %s\n' "$1" >&2; exit 1; }
step() { printf '\n==> %s\n' "$1"; }

# ------------------------------------------------------------ hard guardrail
# The whole point of this script is that it can only ever hit the canary.
# These constants are compared literally, before anything else runs, so a
# copy-paste edit that retargets the script fails immediately and loudly
# rather than dropping the production database.
if [[ "$RELAY_APP" != "colony-relay-canary" ]]; then
    die "refusing to run: RELAY_APP is '${RELAY_APP}', not 'colony-relay-canary'"
fi
if [[ "$DB_APP" != "colony-db-canary-iad" ]]; then
    die "refusing to run: DB_APP is '${DB_APP}', not 'colony-db-canary-iad'"
fi
case "$RELAY_HOST" in
    relay-canary.*) ;;
    *) die "refusing to run: RELAY_HOST '${RELAY_HOST}' is not a canary host" ;;
esac

# --------------------------------------------------------------- arguments
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --yes|-y) ASSUME_YES=1 ;;
        -h|--help)
            sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) die "unknown argument: ${arg} (only --yes is accepted)" ;;
    esac
done

command -v flyctl >/dev/null 2>&1 || die "flyctl is required but not on PATH"
command -v curl >/dev/null 2>&1 || die "curl is required but not on PATH"
flyctl auth whoami >/dev/null 2>&1 || die "flyctl is not authenticated (run: flyctl auth login)"

flyctl apps list 2>/dev/null | awk '{print $1}' | grep -Fxq "$RELAY_APP" \
    || die "app ${RELAY_APP} does not exist - run deploy/fly/provision-canary.sh first"
flyctl apps list 2>/dev/null | awk '{print $1}' | grep -Fxq "$DB_APP" \
    || die "postgres app ${DB_APP} does not exist - run deploy/fly/provision-canary.sh first"

# ------------------------------------------------------------ confirmation
if [[ "$ASSUME_YES" -ne 1 ]]; then
    printf 'This will PERMANENTLY DESTROY all data on the canary relay:\n'
    printf '  app       %s\n' "$RELAY_APP"
    printf '  postgres  %s\n' "$DB_APP"
    printf '  database  %s (dropped and recreated, empty)\n' "$DB_NAME"
    printf '  host      %s\n' "$RELAY_HOST"
    printf '\nProduction (colony-relay / colony-db-iad) is not touched.\n'
    printf '\nType the app name to confirm: '
    read -r CONFIRM
    [[ "$CONFIRM" == "$RELAY_APP" ]] || die "confirmation did not match - nothing was changed"
fi

# ------------------------------------------------- 1. stop the relay machine
step "Stopping ${RELAY_APP} machines"
# `-q` prints ids padded with spaces and a trailing blank line; awk trims
# both, so the ids below are safe to pass straight to flyctl.
MACHINE_IDS="$(flyctl machines list -a "$RELAY_APP" -q 2>/dev/null | awk 'NF {print $1}' || true)"
if [[ -z "${MACHINE_IDS//[[:space:]]/}" ]]; then
    printf '  no machines found (nothing deployed yet) - continuing\n'
else
    # Quote the expansion out of a single word: this shell may be zsh, which
    # does not word-split unquoted parameters the way bash does.
    while IFS= read -r machine_id; do
        [[ -n "$machine_id" ]] || continue
        printf '  stopping %s\n' "$machine_id"
        flyctl machine stop "$machine_id" -a "$RELAY_APP" >/dev/null
    done <<< "$MACHINE_IDS"
fi

# Every relay connection must be gone before DROP DATABASE can succeed; the
# terminate below is the belt to that braces.
step "Waiting for connections to drain"
sleep 5

# ------------------------------------------------ 2. drop and recreate the DB
step "Recreating database ${DB_NAME} on ${DB_APP}"

SQL="SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
      WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${DB_NAME};
CREATE DATABASE ${DB_NAME};
DO \$\$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${DB_USER}') THEN
    EXECUTE 'ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER}';
  END IF;
END
\$\$;"

# Base64 keeps the SQL intact through the two shell layers between here and
# psql: flyctl ssh console -C splits on spaces and quotes do not survive it.
# Same trick deploy/fly/new-community.sh uses.
SQL_B64=$(printf '%s' "$SQL" | base64 | tr -d '\n')

# Connect to the maintenance `postgres` database - you cannot drop the
# database you are connected to.
#
# Retried: auto_start_machines is on for the canary, so any stray request to
# the public host can wake the relay between the terminate and the DROP and
# reopen a connection, which makes DROP DATABASE fail with "is being accessed
# by other users". Re-running the whole block is safe - it is idempotent.
DROP_OK=0
for attempt in 1 2 3; do
    if flyctl ssh console -a "$DB_APP" -C "sh -c 'echo ${SQL_B64} | base64 -d | PGPASSWORD=\$OPERATOR_PASSWORD psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -f -'"; then
        DROP_OK=1
        break
    fi
    printf '  attempt %s failed, retrying\n' "$attempt" >&2
    sleep 5
done
[[ "$DROP_OK" -eq 1 ]] || die "could not recreate ${DB_NAME} after 3 attempts"

printf '  database %s is empty\n' "$DB_NAME"

# --------------------------------------------- 3. restart the relay machine
step "Starting ${RELAY_APP} machines"
if [[ -z "${MACHINE_IDS//[[:space:]]/}" ]]; then
    printf '  nothing to start - deploy an image first:\n'
    printf '    flyctl deploy --config deploy/fly/fly.canary.toml --image <tag> -a %s\n' "$RELAY_APP"
    exit 0
fi
while IFS= read -r machine_id; do
    [[ -n "$machine_id" ]] || continue
    printf '  starting %s\n' "$machine_id"
    flyctl machine start "$machine_id" -a "$RELAY_APP" >/dev/null
done <<< "$MACHINE_IDS"

# ------------------------------------------------------- 4. verify readiness
# BUZZ_AUTO_MIGRATE=true means the relay rebuilds the whole schema on boot
# against the empty database. Migration 0001 carries
# `CREATE EXTENSION IF NOT EXISTS pgcrypto`, so a migrated database needs no
# separate extension pass (unlike a pgschema-provisioned one - see
# scripts/create-required-extensions.sql).
#
# /_readiness on the public port is the only reachable readiness endpoint:
# BUZZ_HEALTH_PORT (8080) is not published by [http_service]. It checks
# Postgres and Redis, so a 200 here proves the migrations landed and both
# backends answer.
step "Waiting for ${RELAY_HOST} to report ready (timeout ${READY_TIMEOUT_SECS}s)"
DEADLINE=$(( $(date +%s) + READY_TIMEOUT_SECS ))
READY=0
while [[ "$(date +%s)" -lt "$DEADLINE" ]]; do
    if curl -fsS --max-time 10 "https://${RELAY_HOST}/_readiness" >/dev/null 2>&1; then
        READY=1
        break
    fi
    printf '.'
    sleep "$READY_POLL_SECS"
done
printf '\n'

if [[ "$READY" -ne 1 ]]; then
    printf '\nReadiness never came up. Inspect:\n' >&2
    printf '  flyctl logs -a %s\n' "$RELAY_APP" >&2
    printf '  flyctl status -a %s\n' "$RELAY_APP" >&2
    printf '  flyctl certs check %s -a %s\n' "$RELAY_HOST" "$RELAY_APP" >&2
    exit 1
fi

# A NIP-11 document proves the relay is serving its identity, not just that a
# socket is open.
step "Relay identity (NIP-11)"
curl -fsS --max-time 10 -H 'Accept: application/nostr+json' "https://${RELAY_HOST}/" || true
printf '\n'

printf '\nCanary reset complete. %s is up with an empty database.\n' "$RELAY_APP"
printf 'Re-add an owner community with:\n'
printf '  deploy/fly/new-community.sh  # after changing DB_APP to %s\n' "$DB_APP"
