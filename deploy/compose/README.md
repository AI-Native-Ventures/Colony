# Buzz Docker Compose deployment

This is the single-node/VPS deployment bundle. It is intentionally separate from
the root `docker-compose.yml`, which remains local development infrastructure.

## Quick start

```bash
cd deploy/compose
./bootstrap.sh \
  --domain "${OWNED_DOMAIN:?Set the approved public relay domain}" \
  --owner-pubkey "${OWNER_PUBKEY:?Set the approved owner public key}"
./run.sh config
./run.sh start
```

For a public VPS with automatic Let's Encrypt certificates:

```bash
cd deploy/compose
BUZZ_COMPOSE_TLS=true ./run.sh config
BUZZ_COMPOSE_TLS=true ./run.sh start
```

`bootstrap.sh` validates the public host and owner public key, generates stable
service secrets, and writes a mode-`600` `.env`. It never generates or stores
the human owner's private key. Use `--image` with an immutable `sha-...` tag or
image digest before public release.

For the authority gates, public-host checks, packaged-app test, backup procedure,
and proof-state template, follow the
[owned relay operations runbook](../../docs/operations/owned-relay-runbook.md).

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

Run `./run.sh backup-hint` for the backup checklist.

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
./run.sh config
```

Keep `RELAY_OWNER_PUBKEY` as the existing owner's 64-character hex public key.
Keep the owner private key outside this deployment. Preserve all stable service
secrets when reconstructing an existing environment; regenerating them changes
relay or storage identity and is not a routine recovery action.

## Local validation

The direct-port path below is only for an isolated local or pre-edge check. A
public deployment must use the complete operations runbook.

```bash
cd deploy/compose
./bootstrap.sh \
  --domain "${OWNED_DOMAIN:?Set the reviewed test domain}" \
  --owner-pubkey "${OWNER_PUBKEY:?Set the reviewed test owner public key}"
./run.sh config
./run.sh start
curl -fsS "http://127.0.0.1:$(grep -E '^BUZZ_HTTP_PORT=' .env | cut -d= -f2-)/_liveness"
./run.sh status
```
