# Buzz Docker Compose deployment

This is the single-node/VPS deployment bundle. It is intentionally separate from
the root `docker-compose.yml`, which remains local development infrastructure.

## Production quick start

```bash
cd deploy/compose
: "${OWNED_IMAGE:?Set the approved immutable image tag or digest}"
./bootstrap.sh \
  --domain "${OWNED_DOMAIN:?Set the approved public relay domain}" \
  --owner-pubkey "${OWNER_PUBKEY:?Set the approved owner public key}" \
  --image "${OWNED_IMAGE}"
BUZZ_COMPOSE_TLS=true ./run.sh config >/dev/null
```

`bootstrap.sh` validates the public host and owner public key, generates stable
service secrets, and writes a mode-`600` `.env`. It never generates or stores
the human owner's private key. `OWNED_IMAGE` must be an approved immutable
`sha-...` tag or image digest.

`run.sh config` renders secret-bearing configuration. Validate it with output
redirected to `/dev/null`, as above, or to an operator-only mode-`600` file that
is securely removed after review. Do not print or attach the rendered output.

For the authority gates, public-host checks, packaged-app test, backup procedure,
and proof-state template, follow the
[owned relay operations runbook](../../docs/operations/owned-relay-runbook.md).

**Deployment is blocked** until that runbook's provider-specific,
write-consistent backup and restore commands exist and a restore drill has
proved one recovery point across Postgres, object/media, git, secrets, and any
required Redis state. After that gate passes:

```bash
cd deploy/compose
BUZZ_COMPOSE_TLS=true ./run.sh start
```

## Production notes

- Requires Docker Compose v2.24.4 or newer; the TLS override uses Compose's
  `!reset` tag to remove the direct relay port when Caddy terminates HTTPS.
- Default `BUZZ_IMAGE` tracks `ghcr.io/block/buzz:main` for early testing. Pin it to `ghcr.io/block/buzz:sha-<7>` or a semver release tag for production once available.
- Keep `BUZZ_RELAY_PRIVATE_KEY`, `BUZZ_GIT_HOOK_HMAC_SECRET`, database/Redis,
  and S3 secrets stable across restarts.
- `RELAY_OWNER_PUBKEY` is intentionally not prefixed with `BUZZ_`; it must be a
  64-character hex Nostr pubkey when closed relay mode is enabled.
- `BUZZ_AUTO_MIGRATE` is opt-in. Set `BUZZ_AUTO_MIGRATE=true` or run
  `buzz-admin migrate` before starting the relay when bootstrapping a fresh
  database. Auto-migration requires an image that includes embedded SQLx
  migrations.
- The stack uses Postgres, Redis, MinIO, and a git data volume because
  those are real Buzz dependencies today. Minimal mode can simplify this later.
- The bundled Compose stack fixes the relay endpoint to `http://minio:9000` and
  `BUZZ_S3_ADDRESSING_STYLE=path`: Docker DNS resolves `minio`, not
  `<bucket>.minio`. It is not configurable for an external S3 provider through
  `.env`; use the Helm chart or a custom Compose configuration for providers
  such as new Railway Storage Buckets that require `virtual` addressing.

`./run.sh backup-hint` prints a state inventory reminder only. It performs no
backup or restore and cannot satisfy the recovery gate.

## Advanced or recovery configuration

Manual `.env` editing is reserved for advanced deployments and recovery from an
approved encrypted configuration backup. For a new normal deployment, use
`bootstrap.sh`.

```bash
cd deploy/compose
cp .env.example .env
$EDITOR .env
chmod 600 .env
! grep -q "CHANGE_ME" .env
BUZZ_COMPOSE_TLS=true ./run.sh config >/dev/null
```

Keep `RELAY_OWNER_PUBKEY` as the existing owner's 64-character hex public key.
Keep the owner private key outside this deployment. Preserve all stable service
secrets when reconstructing an existing environment; regenerating them changes
relay or storage identity and is not a routine recovery action.

## Local validation

The non-TLS, direct-port path below is only for an isolated local or pre-edge
check. It is not a public deployment path. A public deployment must use
`BUZZ_COMPOSE_TLS=true` and the complete operations runbook.

```bash
cd deploy/compose
./bootstrap.sh \
  --domain "${OWNED_DOMAIN:?Set the reviewed test domain}" \
  --owner-pubkey "${OWNER_PUBKEY:?Set the reviewed test owner public key}" \
  --image "${OWNED_IMAGE:?Set the reviewed immutable test image}"
./run.sh config >/dev/null
./run.sh start
curl -fsS "http://127.0.0.1:$(grep -E '^BUZZ_HTTP_PORT=' .env | cut -d= -f2-)/_liveness"
./run.sh status
```
