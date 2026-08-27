#!/usr/bin/env bash
# Provision the Colony CANARY relay stack on Fly.io.
#
#   deploy/fly/provision-canary.sh
#
# Creates everything deploy/fly/fly.canary.toml expects: the app, its volume,
# an unmanaged Postgres cluster, a Redis machine, a Tigris bucket, the TLS
# certificates, and the app secrets. It does NOT deploy a relay image - the
# deploy command is printed at the end so the image tag stays an explicit
# human choice.
#
# The script is idempotent: every step asks "does this already exist" first
# and skips if it does, so a partial run can simply be re-run. It never
# deletes anything and it never touches the production apps.
#
# Optional environment:
#   CANARY_OWNER_PUBKEY      64-hex - becomes RELAY_OWNER_PUBKEY on the canary
#   CANARY_OPERATOR_PUBKEYS  comma-separated 64-hex - RELAY_OPERATOR_PUBKEYS
#   FLY_ORG                  Fly organization slug (default: personal)
#
# Requires: flyctl authenticated against the account owning colony-relay,
# plus openssl for secret generation.

set -euo pipefail

# ---------------------------------------------------------------- constants
RELAY_APP="colony-relay-canary"
DB_APP="colony-db-canary-iad"
REDIS_APP="colony-redis-canary"
BUCKET="colony-relay-canary-media"

RELAY_VOLUME="colony_relay_canary_data"
REDIS_VOLUME="colony_redis_canary_data"

REGION="iad"
ORG="${FLY_ORG:-personal}"

DOMAIN="colony.ainative.ventures"
RELAY_HOST="relay-canary.${DOMAIN}"
ADMIN_HOST="admin-canary.${DOMAIN}"

# Same database name production uses, so deploy/fly/new-community.sh works
# against the canary with only its DB_APP changed.
DB_NAME="colony_relay"
# `flyctl postgres attach` derives the role from the consuming app name with
# hyphens turned into underscores; pin it so canary-reset.sh can hand the
# recreated database back to the same owner.
DB_USER="colony_relay_canary"

REDIS_VOLUME_GB=1
RELAY_VOLUME_GB=3
PG_VOLUME_GB=1

# Smallest shared machine Fly offers, matching production's [[vm]] block.
VM_SIZE="shared-cpu-1x"
VM_MEMORY_MB=512

REDIS_IMAGE="library/redis:7-alpine"

# ------------------------------------------------------------------ helpers
CREATED=()
SKIPPED=()

note_created() { CREATED+=("$1"); printf '  created  %s\n' "$1"; }
note_skipped() { SKIPPED+=("$1"); printf '  exists   %s\n' "$1"; }
step() { printf '\n==> %s\n' "$1"; }
die() { printf 'Error: %s\n' "$1" >&2; exit 1; }

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH"
}

app_exists() {
    flyctl apps list 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
}

volume_exists() {
    # `flyctl volumes list` prints one row per volume; match on the NAME column.
    flyctl volumes list -a "$1" 2>/dev/null \
        | awk -F'│' 'NR>1 {gsub(/ /,"",$3); print $3}' \
        | grep -Fxq "$2"
}

secret_exists() {
    flyctl secrets list -a "$1" 2>/dev/null \
        | awk -F'│' 'NR>1 {gsub(/ /,"",$1); print $1}' \
        | grep -Fxq "$2"
}

cert_exists() {
    flyctl certs list -a "$1" 2>/dev/null | awk '{print $1}' | grep -Fxq "$2"
}

bucket_exists() {
    flyctl storage list 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
}

machine_count() {
    # -q prints machine ids and nothing else, so a line count is the machine
    # count. `|| true` keeps set -e happy when the app has no machines yet.
    flyctl machines list -a "$1" -q 2>/dev/null | awk 'NF' | wc -l | tr -d ' '
}

require_cmd flyctl
require_cmd openssl

# Guardrail: every name this script touches carries "canary". If any of them
# ever stops doing so, a typo has aimed the script at production.
for name in "$RELAY_APP" "$DB_APP" "$REDIS_APP" "$BUCKET" "$RELAY_VOLUME" \
    "$REDIS_VOLUME" "$RELAY_HOST" "$ADMIN_HOST"; do
    case "$name" in
        *canary*) ;;
        *) die "refusing to run: '$name' is not a canary name" ;;
    esac
done

flyctl auth whoami >/dev/null 2>&1 || die "flyctl is not authenticated (run: flyctl auth login)"

printf 'Provisioning the Colony canary stack in org "%s", region %s.\n' "$ORG" "$REGION"

# ------------------------------------------------------------- 1. relay app
step "Relay app: ${RELAY_APP}"
if app_exists "$RELAY_APP"; then
    note_skipped "app ${RELAY_APP}"
else
    flyctl apps create "$RELAY_APP" --org "$ORG" >/dev/null
    note_created "app ${RELAY_APP}"
fi

# ---------------------------------------------------------- 2. relay volume
step "Relay volume: ${RELAY_VOLUME}"
if volume_exists "$RELAY_APP" "$RELAY_VOLUME"; then
    note_skipped "volume ${RELAY_VOLUME} on ${RELAY_APP}"
else
    flyctl volumes create "$RELAY_VOLUME" \
        -a "$RELAY_APP" -r "$REGION" -s "$RELAY_VOLUME_GB" --yes >/dev/null
    note_created "volume ${RELAY_VOLUME} (${RELAY_VOLUME_GB}GB, ${REGION})"
fi

# -------------------------------------------------------------- 3. postgres
step "Postgres: ${DB_APP}"
if app_exists "$DB_APP"; then
    note_skipped "postgres ${DB_APP}"
else
    # Unmanaged (flex) Postgres, mirroring production's colony-db-iad, which
    # runs flyio/postgres-flex:18.1. Single node, smallest shared VM.
    flyctl postgres create \
        --name "$DB_APP" \
        --org "$ORG" \
        --region "$REGION" \
        --initial-cluster-size 1 \
        --vm-size "$VM_SIZE" \
        --volume-size "$PG_VOLUME_GB" \
        --flex
    note_created "postgres ${DB_APP} (1 node, ${VM_SIZE}, ${PG_VOLUME_GB}GB)"
fi

# ---------------------------------------------------------- 4. DATABASE_URL
step "DATABASE_URL secret on ${RELAY_APP}"
if secret_exists "$RELAY_APP" DATABASE_URL; then
    note_skipped "secret DATABASE_URL"
else
    # `postgres attach` creates the database and role and sets DATABASE_URL on
    # the consuming app in one shot, so the connection string is never printed
    # here and never lands in a file.
    flyctl postgres attach "$DB_APP" \
        -a "$RELAY_APP" \
        --database-name "$DB_NAME" \
        --database-user "$DB_USER" \
        --yes
    note_created "secret DATABASE_URL (db ${DB_NAME}, role ${DB_USER})"
fi

# ------------------------------------------------------------------ 5. redis
step "Redis: ${REDIS_APP}"
REDIS_PASSWORD=""
if app_exists "$REDIS_APP"; then
    note_skipped "app ${REDIS_APP}"
else
    flyctl apps create "$REDIS_APP" --org "$ORG" >/dev/null
    note_created "app ${REDIS_APP}"
fi

if volume_exists "$REDIS_APP" "$REDIS_VOLUME"; then
    note_skipped "volume ${REDIS_VOLUME} on ${REDIS_APP}"
else
    flyctl volumes create "$REDIS_VOLUME" \
        -a "$REDIS_APP" -r "$REGION" -s "$REDIS_VOLUME_GB" --yes >/dev/null
    note_created "volume ${REDIS_VOLUME} (${REDIS_VOLUME_GB}GB, ${REGION})"
fi

if [[ "$(machine_count "$REDIS_APP")" -gt 0 ]]; then
    note_skipped "redis machine on ${REDIS_APP}"
    if ! secret_exists "$RELAY_APP" REDIS_URL; then
        printf '  WARNING: %s already has a machine but %s has no REDIS_URL.\n' \
            "$REDIS_APP" "$RELAY_APP" >&2
        printf '           The password is only knowable from the running\n' >&2
        printf '           machine config; set REDIS_URL by hand, or destroy\n' >&2
        printf '           the machine and re-run this script.\n' >&2
    fi
else
    # Production runs plain `library/redis:7-alpine` as a bare Fly machine with
    # an appendonly volume rather than an Upstash `fly redis` instance
    # (`flyctl redis list` is empty for this org). Mirror that so the canary
    # exercises the same client path.
    REDIS_PASSWORD="$(openssl rand -hex 24)"
    flyctl machine run "$REDIS_IMAGE" \
        -a "$REDIS_APP" \
        -r "$REGION" \
        --name "${REDIS_APP}-${REGION}" \
        --vm-size "$VM_SIZE" \
        --vm-memory "$VM_MEMORY_MB" \
        --volume "${REDIS_VOLUME}:/data" \
        --restart on-failure \
        --detach \
        -- redis-server --appendonly yes --requirepass "$REDIS_PASSWORD" >/dev/null
    note_created "redis machine ${REDIS_APP}-${REGION} (${REDIS_IMAGE})"
fi

# ------------------------------------------------------------- 6. REDIS_URL
step "REDIS_URL secret on ${RELAY_APP}"
if secret_exists "$RELAY_APP" REDIS_URL; then
    note_skipped "secret REDIS_URL"
elif [[ -n "$REDIS_PASSWORD" ]]; then
    # 6PN private networking: <app>.internal resolves inside the org only, so
    # the canary Redis is never exposed publicly and needs no certificate.
    flyctl secrets set --stage -a "$RELAY_APP" \
        "REDIS_URL=redis://default:${REDIS_PASSWORD}@${REDIS_APP}.internal:6379" >/dev/null
    note_created "secret REDIS_URL"
else
    printf '  SKIPPED: cannot set REDIS_URL without the password (see warning above)\n' >&2
fi
unset REDIS_PASSWORD

# --------------------------------------------------- 7. relay signing key
step "BUZZ_RELAY_PRIVATE_KEY secret on ${RELAY_APP}"
if secret_exists "$RELAY_APP" BUZZ_RELAY_PRIVATE_KEY; then
    note_skipped "secret BUZZ_RELAY_PRIVATE_KEY"
else
    # A fresh 32-byte secp256k1 secret key, generated here and never read
    # back. It is NOT copied from production: sharing the signing key would
    # let canary-signed kind:13534 events verify as production-relay events.
    flyctl secrets set --stage -a "$RELAY_APP" \
        "BUZZ_RELAY_PRIVATE_KEY=$(openssl rand -hex 32)" >/dev/null
    note_created "secret BUZZ_RELAY_PRIVATE_KEY (freshly generated)"
fi

# ------------------------------------------------------- 8. Tigris bucket
step "Tigris bucket: ${BUCKET}"
if bucket_exists "$BUCKET"; then
    note_skipped "bucket ${BUCKET}"
    if ! secret_exists "$RELAY_APP" BUZZ_S3_ACCESS_KEY; then
        printf '  WARNING: bucket exists but %s has no BUZZ_S3_ACCESS_KEY.\n' "$RELAY_APP" >&2
        printf '           Tigris only reveals a key pair at creation time.\n' >&2
        printf '           Mint one in the Tigris dashboard (flyctl storage\n' >&2
        printf '           dashboard) and set BUZZ_S3_ACCESS_KEY /\n' >&2
        printf '           BUZZ_S3_SECRET_KEY by hand.\n' >&2
    fi
elif secret_exists "$RELAY_APP" BUZZ_S3_ACCESS_KEY; then
    note_skipped "bucket ${BUCKET} (credentials already set)"
else
    # `flyctl storage create` prints the key pair once. Capture it, translate
    # the AWS_* names it emits into the BUZZ_S3_* names the relay reads
    # (crates/buzz-relay/src/config.rs), and never echo the values.
    STORAGE_OUT="$(flyctl storage create -n "$BUCKET" -o "$ORG" --yes 2>&1)"
    S3_KEY="$(printf '%s\n' "$STORAGE_OUT" | sed -n 's/.*AWS_ACCESS_KEY_ID[:=][[:space:]]*\([^[:space:]]*\).*/\1/p' | head -1)"
    S3_SECRET="$(printf '%s\n' "$STORAGE_OUT" | sed -n 's/.*AWS_SECRET_ACCESS_KEY[:=][[:space:]]*\([^[:space:]]*\).*/\1/p' | head -1)"
    unset STORAGE_OUT
    if [[ -n "$S3_KEY" && -n "$S3_SECRET" ]]; then
        flyctl secrets set --stage -a "$RELAY_APP" \
            "BUZZ_S3_ACCESS_KEY=${S3_KEY}" \
            "BUZZ_S3_SECRET_KEY=${S3_SECRET}" >/dev/null
        note_created "bucket ${BUCKET} + secrets BUZZ_S3_ACCESS_KEY/BUZZ_S3_SECRET_KEY"
    else
        note_created "bucket ${BUCKET}"
        printf '  WARNING: could not parse the Tigris key pair out of flyctl\n' >&2
        printf '           output. Run "flyctl storage dashboard", mint a key\n' >&2
        printf '           for %s, then run:\n' "$BUCKET" >&2
        printf '             flyctl secrets set --stage -a %s \\\n' "$RELAY_APP" >&2
        printf '               BUZZ_S3_ACCESS_KEY=... BUZZ_S3_SECRET_KEY=...\n' >&2
    fi
    unset S3_KEY S3_SECRET
fi

# ------------------------------------------- 9. optional owner / operators
step "Owner and operator pubkeys (optional)"
if [[ -n "${CANARY_OWNER_PUBKEY:-}" ]]; then
    if ! [[ "$CANARY_OWNER_PUBKEY" =~ ^[0-9a-f]{64}$ ]]; then
        die "CANARY_OWNER_PUBKEY must be 64 lowercase hex chars"
    fi
    flyctl secrets set --stage -a "$RELAY_APP" \
        "RELAY_OWNER_PUBKEY=${CANARY_OWNER_PUBKEY}" >/dev/null
    note_created "secret RELAY_OWNER_PUBKEY"
elif secret_exists "$RELAY_APP" RELAY_OWNER_PUBKEY; then
    note_skipped "secret RELAY_OWNER_PUBKEY"
else
    printf '  none set. BUZZ_REQUIRE_RELAY_MEMBERSHIP is "true" on the canary,\n'
    printf '  so without an owner nobody can join it. Re-run with\n'
    printf '  CANARY_OWNER_PUBKEY=<64-hex> or set the secret by hand.\n'
fi

if [[ -n "${CANARY_OPERATOR_PUBKEYS:-}" ]]; then
    flyctl secrets set --stage -a "$RELAY_APP" \
        "RELAY_OPERATOR_PUBKEYS=${CANARY_OPERATOR_PUBKEYS}" >/dev/null
    note_created "secret RELAY_OPERATOR_PUBKEYS"
elif secret_exists "$RELAY_APP" RELAY_OPERATOR_PUBKEYS; then
    note_skipped "secret RELAY_OPERATOR_PUBKEYS"
fi

# -------------------------------------------------------- 10. certificates
step "TLS certificates"
# Ordering note: the wildcard *.colony.ainative.ventures already resolves both
# canary names to the PRODUCTION relay, so Fly's ACME validation cannot
# succeed until the explicit CNAMEs below are in place. Requesting the certs
# now is still correct - Fly retries and they flip to "Issued" on their own
# once DNS is right.
for host in "$RELAY_HOST" "$ADMIN_HOST"; do
    if cert_exists "$RELAY_APP" "$host"; then
        note_skipped "certificate ${host}"
    else
        flyctl certs add "$host" -a "$RELAY_APP" >/dev/null
        note_created "certificate ${host} (pending DNS)"
    fi
done

# ------------------------------------------------------------------ summary
printf '\n================ summary ================\n'
printf 'Created (%d):\n' "${#CREATED[@]}"
if [[ ${#CREATED[@]} -eq 0 ]]; then
    printf '  (nothing - the stack was already complete)\n'
else
    printf '  - %s\n' "${CREATED[@]}"
fi
printf 'Skipped, already present (%d):\n' "${#SKIPPED[@]}"
if [[ ${#SKIPPED[@]} -eq 0 ]]; then
    printf '  (nothing)\n'
else
    printf '  - %s\n' "${SKIPPED[@]}"
fi

cat <<EOF

================ DNS records to add by hand ================

Add these at the DNS provider for ${DOMAIN}. Both are EXPLICIT records that
must override the existing wildcard *.${DOMAIN} -> colony-relay.fly.dev; a
more specific name beats a wildcard, which is the only reason the canary can
live inside a domain whose wildcard points at production.

  Type   Name                    Value                          Proxy
  ----   ----                    -----                          -----
  CNAME  relay-canary            ${RELAY_APP}.fly.dev   DNS only
  CNAME  admin-canary            ${RELAY_APP}.fly.dev   DNS only

If the provider is Cloudflare, both records MUST be "DNS only" (grey cloud).
An orange-clouded record terminates TLS at Cloudflare, which breaks Fly's
ACME HTTP-01 validation and mangles the WebSocket upgrade.

After the records propagate:

  flyctl certs check ${RELAY_HOST} -a ${RELAY_APP}
  flyctl certs check ${ADMIN_HOST} -a ${RELAY_APP}

================ next steps ================

1. Deploy a relay image (nothing is running yet):

     flyctl deploy --config deploy/fly/fly.canary.toml \\
       --image ghcr.io/ai-native-ventures/colony-relay:<tag> \\
       -a ${RELAY_APP}

   The first deploy also applies the staged secrets above and runs the
   schema migrations, because fly.canary.toml sets BUZZ_AUTO_MIGRATE=true.

2. Prove it:

     curl -sS https://${RELAY_HOST}/_readiness
     curl -sS -H 'Accept: application/nostr+json' https://${RELAY_HOST}/

3. Wipe and reseed at any time with:

     scripts/canary-reset.sh
EOF
