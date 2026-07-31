# Owned Relay Operations Runbook

This runbook takes one approved company identity from configuration through an
owned Buzz relay and an owned desktop distribution. It is deliberately
proof-gated: preparing configuration, starting infrastructure, packaging the
app, and declaring the product live are separate states.

## Purpose and non-goals

The target is one company on one relay we operate:

- the Buzz relay is the company's host-bound community and source of truth;
- the desktop keeps the human's Nostr identity in the existing OS keyring;
- managed agents have independent Nostr identities and use owner-signed NIP-OA
  delegation;
- a fresh owned desktop build connects directly to the reviewed relay; and
- Builderlab remains an optional hosted-community path, not a dependency of
  normal startup, chat, membership, or agent work.

This procedure does not create a Builderlab replacement, a multi-company
control plane, a Cloudflare Worker relay, a new login provider, or a
company-selection interface. It does not authorize a branding or internal
Buzz-symbol rename.

## Authority gate and approved inputs

Do not create paid infrastructure, change DNS, publish a package, or expose the
relay until the owner has approved all of the following:

| Input | Required decision |
| --- | --- |
| Origin | Provider, region, host size, recurring cost, and operator access |
| Public host | One lowercase relay domain, such as `office.example.com` |
| Owner identity | One stable 64-character hex Nostr public key |
| Edge | DNS owner and whether Cloudflare is DNS-only or proxied |
| Relay image | An immutable `sha-...` tag or image digest |
| Recovery | Who controls encrypted owner-key and service-state backups |
| Distribution | Test audience and macOS signing/notarization status |

The approved domain and owner public key are public identifiers, not secret
material. The origin address, access credentials, service secrets, human
private key, agent private keys, delegation signatures, and backup locations
remain confidential.

## Owner identity preparation

Establish or restore the owner's identity on the approved owner device before
configuring the relay. The owner public key is infrastructure input; the
matching private key is not.

1. Confirm that the desktop can load the intended identity from the OS keyring.
2. Copy the public ID from the desktop and verify it through a second trusted
   display or offline tool.
3. Convert an `npub` to the exact 64-character lowercase hex public key if
   necessary. Do not convert, paste, or transmit an `nsec` on the origin host.
4. Record the public key in the approved deployment record.
5. Store private-key recovery material in the approved encrypted recovery
   backup, separately from the relay host and its `.env`.

Do not use `buzz-admin generate-key` on the production origin as a shortcut for
the human owner. A generated key on that host would not establish the desktop
keyring and recovery boundary required by this deployment.

The bootstrap accepts only the 64-character hex public key. It never generates
or stores the human private key.

## Origin prerequisites

Before copying production configuration to the origin, prove:

- Docker Engine and Docker Compose v2.24.4 or newer are installed;
- the operator workstation has `curl`, `dig`, and `openssl` for acceptance
  checks;
- the host has persistent storage sized for Postgres, Redis, MinIO, and git;
- outbound access can pull the approved container images;
- only approved operators can access the host;
- inbound TCP 80 and 443 reach the origin when bundled Caddy is used;
- database, Redis, MinIO, admin, and direct relay ports are not publicly
  exposed; and
- the approved backup destination is reachable without placing backup
  credentials in the repository.

Use `deploy/compose/compose.yml` with
`deploy/compose/compose.caddy.yml`. Do not enable
`BUZZ_COMPOSE_DEV=true` on the public origin: the development override publishes
state-service and admin ports.

The Compose bundle runs the relay, Postgres, Redis, MinIO, and persistent git
storage on the origin. Single-node Compose is appropriate for the first owned
company, but it is not high availability. A host or disk failure remains an
availability event and must be covered by tested backups.

## DNS, TLS, and WebSocket proxying

Choose one approved edge pattern:

1. **DNS-only Cloudflare:** Cloudflare supplies DNS; bundled Caddy obtains and
   serves the public certificate and proxies HTTPS/WebSockets to the relay.
2. **Proxied Cloudflare:** Cloudflare proxies the public connection. Keep
   end-to-end TLS to bundled Caddy, use Full (strict) origin validation, and
   confirm WebSocket support, upload limits, and cache bypass behavior for
   relay/API traffic.

In both patterns:

- create the approved `A`/`AAAA` record for `OWNED_DOMAIN`;
- preserve the original `Host` header through every proxy hop;
- allow WebSocket upgrades on `/`;
- do not cache authenticated relay, query, event, media-write, or git traffic;
- do not rewrite the WebSocket URL or append a path; and
- keep origin ports and state services firewalled from the public internet.

Cloudflare may provide DNS, edge TLS, and WebSocket proxying. It does not run the
Buzz relay or its state. This architecture is not a Cloudflare Worker
deployment.

Do not proceed until the DNS record, origin target, TLS mode, and proxy setting
match the approved deployment record.

## Compose bootstrap and configuration validation

Work from the repository root at the reviewed commit. These are the exact
local preparation commands for validating the bootstrap boundary:

```bash
: "${OWNED_DOMAIN:?Set the approved public relay domain}"
: "${OWNER_PUBKEY:?Set the approved 64-character hex Nostr public key}"

./deploy/compose/bootstrap.sh \
  --domain "${OWNED_DOMAIN}" \
  --owner-pubkey "${OWNER_PUBKEY}"

BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh config
```

The default image is a pre-release convenience and is not eligible for public
release. For the production `.env`, use the approved immutable image on the
first invocation instead:

```bash
: "${OWNED_IMAGE:?Set an approved immutable image tag or digest}"

./deploy/compose/bootstrap.sh \
  --domain "${OWNED_DOMAIN}" \
  --owner-pubkey "${OWNER_PUBKEY}" \
  --image "${OWNED_IMAGE}"
```

Choose one bootstrap invocation for a given checkout. The script refuses to
overwrite an existing `.env`. If the default-image validation flow created an
unstarted `.env`, remove it only after confirming it contains no production
state, then rerun bootstrap with `--image`. Never remove an `.env` belonging to
a started deployment; restore or edit that file through the approved secret
recovery process.

Before first start:

```bash
test "$(stat -f '%Lp' deploy/compose/.env 2>/dev/null || stat -c '%a' deploy/compose/.env)" = "600"
! grep -q "CHANGE_ME" deploy/compose/.env
grep -E '^(BUZZ_IMAGE|BUZZ_DOMAIN|RELAY_URL|BUZZ_REQUIRE_AUTH_TOKEN|BUZZ_REQUIRE_RELAY_MEMBERSHIP|BUZZ_ALLOW_NIP_OA_AUTH|BUZZ_AUTO_MIGRATE|RELAY_OWNER_PUBKEY)=' \
  deploy/compose/.env
BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh config >/dev/null
```

Confirm the visible values match the approved image, domain, URL, owner public
key, and these closed-relay settings:

```text
BUZZ_REQUIRE_AUTH_TOKEN=true
BUZZ_REQUIRE_RELAY_MEMBERSHIP=true
BUZZ_ALLOW_NIP_OA_AUTH=true
BUZZ_AUTO_MIGRATE=true
```

`run.sh config` renders secret-bearing Compose configuration. Review it only in
the protected operator terminal. Redirect it when recording a pass, and never
attach its full output to a ticket, chat, screenshot, or CI artifact. Copy the
generated `.env` to the approved encrypted secret store before first start.

## First deployment

Starting the public stack is an external change. Reconfirm origin cost, DNS,
owner public key, immutable image, and backup ownership immediately before this
gate.

Run from the repository root on the approved origin:

```bash
BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh start
curl -fsS "https://${OWNED_DOMAIN}/_liveness"
curl -fsS "https://${OWNED_DOMAIN}/_readiness"
./deploy/compose/run.sh status
./deploy/compose/run.sh list-members
```

Both health requests must return success, every required service must be
healthy, and the configured public key must appear exactly once with role
`owner`. A healthy process without the expected owner is a failed deployment.

Do not post full `docker compose config`, `.env`, signed events, auth tags,
private keys, cookies, tokens, database URLs, or unredacted service logs as
evidence.

## Relay acceptance checks

Capture redacted evidence for every check below. The
[buzz-cli live testing guide](../../crates/buzz-cli/TESTING.md) defines the
supported client commands and their expected wire behavior. Use the existing
`run.sh add-member`, `remove-member`, and `list-members` operator commands;
do not invent an administrative HTTP endpoint.

### Public DNS, certificate, and WebSocket

```bash
dig +short "${OWNED_DOMAIN}"
curl -fsS "https://${OWNED_DOMAIN}/_liveness"
curl -fsS "https://${OWNED_DOMAIN}/_readiness"
openssl s_client \
  -connect "${OWNED_DOMAIN}:443" \
  -servername "${OWNED_DOMAIN}" </dev/null 2>/dev/null |
  openssl x509 -noout -subject -issuer -dates -fingerprint -sha256

ws_status="$(
  curl --http1.1 --max-time 3 --silent --show-error \
    --output /dev/null --write-out '%{http_code}' \
    --header 'Connection: Upgrade' \
    --header 'Upgrade: websocket' \
    --header 'Sec-WebSocket-Version: 13' \
    --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
    "https://${OWNED_DOMAIN}/" || true
)"
test "${ws_status}" = "101"
```

Record the resolved address, certificate subject/issuer/expiry, both health
statuses, and the `101` result. The `curl` timeout after a successful upgrade is
expected; the asserted HTTP status is the evidence.

Then authenticate through the public `wss://` URL using the packaged desktop or
the authenticated CLI flow. A bare `101` proves proxy transport only; the
signed NIP-42 exchange proves relay authentication.

### Host-to-community binding

List active host mappings from inside the protected origin:

```bash
cd deploy/compose
docker compose --env-file .env -f compose.yml -f compose.caddy.yml \
  exec -T postgres sh -ec \
  'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc \
    "SELECT host FROM communities WHERE archived_at IS NULL ORDER BY host"'
cd ../..
```

The output must contain exactly one line and it must equal `OWNED_DOMAIN`.

Test an unmapped host at the relay's host-binding door, not through NIP-11.
NIP-11 is intentionally host-agnostic and is not an unknown-host test:

```bash
cd deploy/compose
unknown_status="$(
  docker compose --env-file .env -f compose.yml -f compose.caddy.yml \
    exec -T relay bash -ec '
      exec 3<>/dev/tcp/127.0.0.1/3000
      printf "GET / HTTP/1.1\r\nHost: unknown.invalid\r\nAccept: text/html\r\nConnection: close\r\n\r\n" >&3
      sed -n "1{s/.* \\([0-9][0-9][0-9]\\) .*/\\1/p;q}" <&3
    '
)"
test "${unknown_status}" = "404"
cd ../..
```

The response must remain generic and must not reveal another host or community.

### Human membership

1. Connect with the approved owner identity through
   `wss://${OWNED_DOMAIN}` and complete NIP-42 authentication.
2. Confirm `./deploy/compose/run.sh list-members` shows the same public key with
   role `owner`.
3. Attempt the same connection with an unprovisioned test identity. It must be
   rejected by closed-relay membership.
4. Admit one approved second-human test key through the existing invitation
   flow or:

   ```bash
   ./deploy/compose/run.sh add-member "${SECOND_HUMAN_NPUB:?Set the approved test public key}"
   ```

5. Confirm the test human can authenticate only on this host and appears once
   as `member`.
6. Remove the temporary member after the evidence is complete:

   ```bash
   ./deploy/compose/run.sh remove-member "${SECOND_HUMAN_NPUB}"
   ```

Run member mutations serially. Do not parallelize them; same-second roster
events are serialized by operator procedure.

### Managed-agent delegation

Use the desktop's managed-agent flow so the existing runtime creates or
restores the agent key and owner-signed NIP-OA credential:

1. Start the managed agent as the approved owner.
2. Confirm the agent authenticates to `wss://${OWNED_DOMAIN}` without adding
   the agent pubkey directly to the human membership roster.
3. Record the owner and agent public keys and a redacted acceptance log line.
4. In an isolated test agent only, retry with `BUZZ_AUTH_TAG` absent.
5. Retry with a deliberately invalid test auth tag.
6. Confirm both negative cases are rejected and do not create membership.

Never paste the valid auth tag, agent private key, owner private key, or signed
AUTH event into evidence.

### Persistence

Create a disposable test channel, human message, media attachment, and managed
agent through the real product. Record their non-secret identifiers, then run:

```bash
BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh restart
curl -fsS "https://${OWNED_DOMAIN}/_liveness"
curl -fsS "https://${OWNED_DOMAIN}/_readiness"
./deploy/compose/run.sh list-members
```

After reconnect, prove the same membership, message, media object, and agent
authorization remain available. A restart that only returns healthy is not
persistence proof.

## Owned desktop build

Build only after the relay URL has passed the public-host checks:

```bash
. ./bin/activate-hermit
just desktop-owned-build "wss://${OWNED_DOMAIN}"
```

Record:

- source commit SHA and target triple;
- artifact path, checksum, and application version;
- the reviewed embedded relay URL;
- whether the artifact is unsigned, signed, or notarized; and
- the exact automated checks that passed before packaging.

Building an artifact does not authorize distribution. An unsigned local package
is a test artifact, not a public release.

## Packaged desktop and agent acceptance

Use a clean macOS test account, a dedicated test machine, or a separately
identified canary bundle. Never wipe or move the user's normal app data or
keyring entries as a test shortcut.

Against the public relay, capture redacted screenshots and logs proving:

1. A fresh launch creates exactly one local community for the owned relay.
2. No Builderlab browser login, Builderlab command, or community chooser
   appears in the default journey.
3. The relay-local profile/welcome sequence reaches chat.
4. The approved test human can send and receive a message.
5. A managed agent is created or restored with its own stable public key.
6. The agent runtime starts without a missing-private-key error.
7. The agent receives a chat instruction and responds in the same chat.
8. Quitting and relaunching the desktop preserves the same human public key,
   relay URL, and agent public key.
9. Restarting the relay preserves membership, messages, media, and agent
   authorization.

Browser mock tests, a green build, and relay health checks are supporting
evidence. None substitutes for this packaged-app path.

## Backup, upgrade, rollback, and incidents

### Backups

Before launch, before every upgrade, and on the approved schedule:

```bash
./deploy/compose/run.sh backup-hint
```

Back up:

- `deploy/compose/.env` in an encrypted secret store;
- the owner recovery material outside the origin and outside `.env`;
- Postgres with `pg_dump` or a quiesced volume snapshot;
- MinIO bucket contents;
- persistent git data;
- Redis persistence if it is part of the chosen recovery point; and
- Caddy data/config when bundled Caddy owns origin certificates.

Take Postgres and object/git snapshots in the same maintenance window. Encrypt
backups, restrict restore authority, define retention, and run a restore drill
before calling backup coverage proven.

### Upgrades

1. Record the current source commit and running image digest.
2. Complete and verify a current backup.
3. Review migrations and release notes.
4. Change only `BUZZ_IMAGE` to the newly approved immutable reference.
5. Validate with
   `BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh config >/dev/null`.
6. Run `BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh upgrade`.
7. Repeat health, NIP-42, membership, chat, media, agent, and restart checks.

Do not rotate stable service secrets during a routine upgrade.

### Rollback

Keep the previous immutable image digest in the change record. To roll back:

1. Restore `BUZZ_IMAGE` to that exact digest.
2. Review whether the applied database migration is backward-compatible.
3. If it is compatible, run
   `BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh restart`.
4. If it is not compatible, stop and use the approved database/object/git
   restore procedure for the same recovery point.
5. Repeat the relay and packaged-app acceptance checks.

Never use `docker compose down -v`, delete named volumes, generate a replacement
owner identity, or point an existing user's build at an unreviewed relay as
rollback.

The desktop rollback is a new reviewed build with auto-connect disabled or with
the previous reviewed relay URL. It must not erase the user's Nostr identity or
local community record.

### Incidents

- **Relay unavailable:** preserve the selected company and investigate origin,
  Caddy/Cloudflare, Postgres, Redis, and MinIO health. Do not redirect to
  Builderlab or silently create another company.
- **Unknown-host admission:** take the relay out of public service immediately;
  preserve logs, do not mutate tenant records, and treat it as an isolation
  incident.
- **Owner rejected:** compare the keyring identity's public key with
  `RELAY_OWNER_PUBKEY` and the roster. Do not weaken membership enforcement.
- **Agent missing private key:** preserve the existing agent public key and
  inspect keyring/harness logs. Do not generate a replacement identity for a
  persisted agent merely to clear the error.
- **Secret exposure:** revoke or rotate only the exposed credential using a
  reviewed procedure, assess signed-event and backup exposure, and re-prove
  persistence and authorization. A human-key exposure requires an explicit
  identity-transfer decision.
- **State loss or corruption:** stop writes, preserve the failed state for
  diagnosis, and restore Postgres plus object/git data from one consistent
  recovery point.

## Release Evidence

| State | Result | Evidence |
| --- | --- | --- |
| Implemented | pass/fail | commit SHA and changed files |
| Locally tested | pass/fail | contract, unit, and E2E commands |
| Packaged | pass/fail | artifact path, version, embedded relay |
| Deployed | pass/fail | image digest, public host, health checks |
| Live-proven | pass/fail | fresh-install, chat, agent, restart evidence |
