#!/usr/bin/env bash
# Split the `events` catch-all partition on the production relay database.
#
#   deploy/fly/split-events-catch-all.sh              # dry run (default)
#   deploy/fly/split-events-catch-all.sh --dry-run
#   deploy/fly/split-events-catch-all.sh --apply
#
# `events_p_future` was created FROM '2026-07-01' TO MAXVALUE by
# migrations/0001_initial_schema.sql, and until the buzz-db partition manager
# learned to roll it forward it absorbed every month from July 2026 onwards.
# This moves those rows into real monthly partitions and puts the catch-all
# back above them. The SQL, its preconditions and the reason the row move runs
# under `session_replication_role = replica` are all in the .sql beside this.
#
# --apply holds an ACCESS EXCLUSIVE lock on `events` for the whole
# transaction: every read and write of `events` blocks until it commits (one
# to three minutes at 314k rows). Run it in a window the owner picked, and run
# --dry-run first.
#
# Requires: flyctl authenticated against the account owning colony-relay.
#
# To rehearse against the local development database instead of production:
#   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
#     -c "SET colony.split_dry_run = 'false'" \
#     -f deploy/fly/split-events-catch-all.sql

set -euo pipefail

DB_APP="colony-db-iad"
DB_NAME="colony_relay"

SQL_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/split-events-catch-all.sql"

MODE="dry-run"
case "${1:---dry-run}" in
    --dry-run) MODE="dry-run" ;;
    --apply)   MODE="apply" ;;
    *)
        echo "Usage: $0 [--dry-run|--apply]" >&2
        exit 1
        ;;
esac

if [[ ! -f "$SQL_FILE" ]]; then
    echo "Error: $SQL_FILE not found" >&2
    exit 1
fi

if [[ "$MODE" == "apply" ]]; then
    cat >&2 <<EOF

About to rewrite the events partition tree on ${DB_APP}/${DB_NAME}.

Every read and write of \`events\` blocks for the duration of one
transaction: expect one to three minutes of a frozen relay.

EOF
    read -r -p "Type 'apply' to continue: " CONFIRM
    if [[ "$CONFIRM" != "apply" ]]; then
        echo "Aborted." >&2
        exit 1
    fi
    DRY_RUN="false"
else
    DRY_RUN="true"
fi

# The .sql defaults to a dry run when `colony.split_dry_run` is unset, so this
# session-level SET is what makes a real run real. It has to precede the file:
# psql does not interpolate its own variables inside a dollar-quoted body.
SQL="SET colony.split_dry_run = '${DRY_RUN}';
$(cat "$SQL_FILE")"

# Base64 keeps the SQL intact through the two shell layers between here and
# psql (flyctl -C splits on spaces; quotes do not survive it).
SQL_B64=$(printf '%s' "$SQL" | base64 | tr -d '\n')

flyctl ssh console -a "$DB_APP" -C "sh -c 'echo ${SQL_B64} | base64 -d | PGPASSWORD=\$OPERATOR_PASSWORD psql -h localhost -U postgres -d ${DB_NAME} -v ON_ERROR_STOP=1 -f -'"

echo
if [[ "$MODE" == "apply" ]]; then
    echo "Split complete. The relay needs no restart: the partition manager"
    echo "keeps the catch-all rolling from here."
else
    echo "Dry run complete. Re-run with --apply to execute."
fi
