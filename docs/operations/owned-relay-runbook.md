# Owned Relay Operations Runbook

This runbook takes one approved company identity from configuration through an
owned Buzz relay and an owned desktop distribution. It is deliberately
proof-gated: preparing configuration, starting infrastructure, packaging the
app, and declaring the product live are separate states.

## Purpose and non-goals

The target is one company on one relay we operate:

- the Buzz relay is the company's host-bound community and source of truth;
- the desktop prefers the existing OS keyring for the human's Nostr identity
  and retains the existing mode-`600` `identity.key` availability fallback;
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
| Recovery | Provider-specific, write-consistent backup and restore commands, recovery-point identity, storage owner, and a completed restore drill |
| Distribution | Test audience and macOS signing/notarization status |

The approved domain and owner public key are public identifiers, not secret
material. The origin address, access credentials, service secrets, human
private key, agent private keys, delegation signatures, and backup locations
remain confidential.

## Owner identity preparation

Establish or restore the owner's identity on the approved owner device before
configuring the relay. The owner public key is infrastructure input; the
matching private key is not. The desktop stores the identity in the OS keyring
when available and uses its existing mode-`600` `identity.key` fallback when a
keyring write is unavailable. Both locations are device-side secret stores;
neither belongs on the relay host.

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
- database, Redis, MinIO, admin, and direct relay ports remain private in every
  edge mode;
- in DNS-only mode, bundled Caddy's TCP 80 and 443 are public for ACME
  validation and user traffic;
- in Cloudflare-proxied mode, TCP 80 and 443 are restricted, where feasible and
  supported by the provider, to Cloudflare's current
  [published origin ranges](https://www.cloudflare.com/ips/), with a documented
  owner, update cadence, change alert, and post-update health/WebSocket check;
- the approved backup destination is reachable without placing backup
  credentials in the repository; and
- exact provider-specific commands exist for a write-consistent backup and
  restore of Postgres, object/media data, git data, deployment secrets, and any
  Redis state required at that recovery point.

Use `deploy/compose/compose.yml` with
`deploy/compose/compose.caddy.yml`. Do not enable
`BUZZ_COMPOSE_DEV=true` on the public origin: the development override publishes
state-service and admin ports.

The Compose bundle runs the relay, Postgres, Redis, MinIO, and persistent git
storage on the origin. Single-node Compose is appropriate for the first owned
company, but it is not high availability. A host or disk failure remains an
availability event.

**Deployment is blocked** until the approved provider-specific backup and
restore commands are recorded outside the repository, use one named recovery
point across all required state, and have completed a restore drill. The
repository's `run.sh backup-hint` command is only an inventory reminder. It is
not a backup implementation, a restore procedure, or evidence of recoverability.

## DNS, TLS, and WebSocket proxying

Choose one approved edge pattern:

1. **DNS-only Cloudflare:** Cloudflare supplies DNS; bundled Caddy obtains and
   serves the public certificate and proxies HTTPS/WebSockets to the relay.
2. **Proxied Cloudflare:** Cloudflare proxies the public connection. Keep
   end-to-end TLS to bundled Caddy. Record account-level evidence that the zone
   uses Full (strict) SSL/TLS mode, then independently verify the origin
   certificate by connecting to the authorized origin IP with the public
   hostname as SNI.

In both patterns:

- create the approved `A`/`AAAA` record for `OWNED_DOMAIN`;
- preserve the original `Host` header through every proxy hop;
- allow WebSocket upgrades on `/`;
- do not cache authenticated relay, query, event, media-write, or git traffic;
- do not rewrite the WebSocket URL or append a path; and
- keep direct relay and state-service ports private; apply the approved
  mode-specific TCP 80/443 policy above.

Cloudflare may provide DNS, edge TLS, and WebSocket proxying. It does not run the
Buzz relay or its state. This architecture is not a Cloudflare Worker
deployment.

The certificate visible at `https://${OWNED_DOMAIN}` is the Cloudflare edge
certificate when proxying is enabled. That public check does not prove
Cloudflare-to-origin TLS. For a proxied zone, both Full (strict) configuration
evidence and an authorized direct-origin certificate check are mandatory. For a
DNS-only zone, record Full (strict) as not applicable and retain the direct
origin certificate check.

Do not proceed until the DNS record, origin target, edge mode, origin TLS mode,
WebSocket support, upload limits, cache bypass behavior, and proxy setting match
the approved deployment record.

## Compose bootstrap and configuration validation

Work from the repository root at the reviewed commit. Production bootstrap
requires the approved immutable image on the first invocation:

```bash
: "${OWNED_DOMAIN:?Set the approved public relay domain}"
: "${OWNER_PUBKEY:?Set the approved 64-character hex Nostr public key}"
: "${OWNED_IMAGE:?Set the approved immutable image tag or digest}"

./deploy/compose/bootstrap.sh \
  --domain "${OWNED_DOMAIN}" \
  --owner-pubkey "${OWNER_PUBKEY}" \
  --image "${OWNED_IMAGE}"

BUZZ_COMPOSE_TLS=true ./deploy/compose/run.sh config >/dev/null
```

The script refuses to overwrite an existing `.env`. Never remove an `.env`
belonging to a started deployment; restore or edit that file through the
approved secret recovery process. A non-TLS Compose start is permitted only for
an isolated local/pre-edge check, never for the public origin.

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

`run.sh config` renders secret-bearing Compose configuration. Validate it with
output redirected to `/dev/null`, or create it under `umask 077`, keep it
mode-`600`, review it only in the protected operator terminal, and securely
remove it immediately afterward. Never attach its full output to a ticket,
chat, screenshot, or CI artifact. Copy the generated `.env` to the approved
encrypted secret store before first start.

## First deployment

Starting the public stack is an external change. Reconfirm origin cost, DNS,
owner public key, immutable image, and backup ownership immediately before this
gate.

**Do not run `start`** until the provider-specific backup and restore commands
are recorded and a restore drill has proved one write-consistent recovery point
for Postgres, object/media data, git data, `.env`/service secrets, and any Redis
state required by the chosen procedure.

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
[buzz-cli live testing guide](../../crates/buzz-cli/TESTING.md) is a broader
command reference, but portions of its credential setup may lag the current
binary. For this gate, confirm commands against `buzz --help` and
`buzz users set-presence --help` from the same built commit. Use the existing
`run.sh add-member`, `remove-member`, and `list-members` operator commands; do
not invent an administrative HTTP endpoint.

### Public DNS, edge certificate, and WebSocket

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

Record the resolved edge address, edge certificate
subject/issuer/expiry/fingerprint, both health statuses, and the `101` result.
The `curl` timeout after a successful upgrade is expected; the asserted HTTP
status is the evidence. With Cloudflare proxying enabled, these checks prove the
Cloudflare edge only.

### Origin certificate and edge-to-origin TLS

Run this only from an authorized operator workstation that is allowed to reach
the origin directly. Do not publish `ORIGIN_IP`.

```bash
: "${ORIGIN_IP:?Set the approved origin IP in the protected operator shell}"
openssl s_client \
  -connect "${ORIGIN_IP}:443" \
  -servername "${OWNED_DOMAIN}" \
  -verify_hostname "${OWNED_DOMAIN}" \
  -verify_return_error </dev/null
```

The command must complete with `Verify return code: 0 (ok)`. Record a redacted
origin certificate fingerprint and expiry. For a Cloudflare-proxied zone,
attach separate account-level evidence that SSL/TLS mode is Full (strict).
Neither the public edge certificate nor a Cloudflare setting alone proves the
other half.

### NIP-42 authentication through the public host

Use a disposable identity whose public key is either already admitted or is
intentionally left unprovisioned for the negative control. Supply its private
key only from the protected operator workstation; disable shell tracing, avoid
command-line arguments and shell history, and unset the variable immediately:

```bash
. ./bin/activate-hermit
cargo build --release -p buzz-cli

set +x
printf '%s' "Disposable Nostr private key: " >&2
IFS= read -r -s BUZZ_PRIVATE_KEY
printf '\n' >&2
export BUZZ_PRIVATE_KEY
export BUZZ_RELAY_URL="wss://${OWNED_DOMAIN}"
./target/release/buzz users set-presence --status online
unset BUZZ_PRIVATE_KEY
```

`users set-presence` publishes ephemeral kind `20001` over WebSocket and
performs NIP-42. It does not use the NIP-98 HTTP bridge. Other CLI commands that
call `/events`, `/query`, or `/count` use NIP-98 and are not substitutes for
this NIP-42 gate.

For an admitted disposable identity, the command must return an accepted event.
For an unprovisioned disposable identity, the same command must fail closed.
The private key must never enter the origin, a screenshot, a log bundle, or a
shared terminal transcript.

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

1. Connect from the approved owner device through `wss://${OWNED_DOMAIN}` and
   complete the real desktop NIP-42 flow.
2. Confirm `./deploy/compose/run.sh list-members` shows the same public key with
   role `owner`.
3. Run `buzz users set-presence --status online` as an unprovisioned disposable
   identity using the secure environment-variable procedure above. It must be
   rejected by closed-relay membership.
4. Admit one approved disposable second-human public key through the existing
   invitation flow or:

   ```bash
   ./deploy/compose/run.sh add-member "${SECOND_HUMAN_NPUB:?Set the approved test public key}"
   ```

5. Supply the matching disposable private key securely and rerun
   `buzz users set-presence --status online`. It must now succeed through
   NIP-42, and `list-members` must show the identity exactly once as `member`.
6. Confirm the active host-map query still contains only `OWNED_DOMAIN`; the
   member operation must not provision another community.
7. Remove the temporary member after the evidence is complete:

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
4. Treat missing- and tampered-delegation rejection as a separate low-level
   protocol gate. Run it only with a supported harness that constructs the
   WebSocket AUTH event, attaches the selected NIP-OA tag, and records whether
   the relay accepted or rejected that exact exchange.
5. If no such harness is available, record both negative cases as **unproven**.
   Do not infer relay rejection by deleting or editing `BUZZ_AUTH_TAG` in a
   local CLI process; that does not by itself prove which credential reached
   the relay.

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

Closed membership means an arbitrary identity generated by a fresh profile
cannot enter. Use exactly one approved admission path:

- launch on the approved owner device with its existing owner identity; or
- create a disposable identity off-origin, admit its public key first, then
  import the matching private key into the isolated desktop profile.

Import a disposable private key only on the isolated test device, from approved
encrypted recovery material. The desktop must persist it to the OS keyring or
its existing mode-`600` `identity.key` fallback. Never add the private key to
relay configuration, localStorage, evidence, or shell history.

Against the public relay, capture redacted screenshots and logs proving:

1. A fresh profile using one of the admitted identity paths creates exactly one
   local community for the owned relay.
2. No Builderlab browser login, Builderlab command, or community chooser
   appears in the default journey.
3. The relay-local profile/welcome sequence reaches chat.
4. The approved test human can send and receive a message.
5. A managed agent is created or restored with its own stable public key.
6. The agent runtime starts without a missing-private-key error.
7. The agent receives a chat instruction and responds in the same chat.
8. Quitting and relaunching the desktop preserves the same human public key,
   relay URL, and agent public key, whether the human key is in the OS keyring
   or the valid mode-`600` fallback.
9. Restarting the relay preserves membership, messages, media, and agent
   authorization.

Browser mock tests, a green build, and relay health checks are supporting
evidence. None substitutes for this packaged-app path.

## Backup, upgrade, rollback, and incidents

### Backups

This command prints the current state inventory:

```bash
./deploy/compose/run.sh backup-hint
```

It does not back up or restore anything. It is not sufficient to pass the
deployment gate.

Before first deployment, an infrastructure owner must record exact,
provider-specific commands for all of the following in the protected operations
record:

1. Entering a write-quiescent state or using a provider mechanism that
   guarantees cross-service write consistency.
2. Creating a named recovery point containing:
   - `deploy/compose/.env` and service secrets in an encrypted secret store;
   - owner recovery material stored separately from the origin and `.env`;
   - Postgres;
   - MinIO/object media;
   - persistent git data;
   - Redis AOF/snapshot state if required by the chosen recovery contract; and
   - Caddy data/config if it is required to restore origin TLS.
3. Verifying checksums, encryption, retention, access control, and backup
   completion for that recovery-point identifier.
4. Restoring every required component into an isolated environment using the
   exact recorded restore commands.
5. Starting the restored relay and proving the same host mapping, membership,
   messages, media, git content, relay/service identity from restored secrets,
   and required Redis-backed behavior.

The restore drill must use one recovery-point identifier across Postgres,
object/media, git, secrets, and any required Redis state. Independent snapshots
from unrelated times are not a proven recovery set. Until this drill passes,
mark `Deployed` and `Live-proven` as fail and do not start the public relay.

Repeat the write-consistent procedure on the approved schedule and before every
upgrade. Encrypt backups, restrict restore authority, and test restores on the
defined cadence.

### Upgrades

1. Record the current source commit and running image digest.
2. Complete and verify a current write-consistent recovery point using the
   provider-specific commands.
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
   and required-Redis restore commands for the same write-consistent recovery
   point.
5. Repeat the relay and packaged-app acceptance checks.

Never use `docker compose down -v`, delete named volumes, generate a replacement
owner identity, or point an existing user's build at an unreviewed relay as
rollback.

Application-version rollback means reinstalling the previous reviewed desktop
artifact. It does not retarget an existing profile: the embedded default relay
and auto-connect flag are consulted only when the profile has no stored
community. An old or differently configured build continues to use the
existing stored community.

Moving an existing profile to another relay is a separate relay/community
migration. Use only a supported community-switching or migration flow with
explicit user approval and its own identity, membership, data, and rollback
proof. Do not edit local storage, delete the community, or assume that
installing a build with a different default URL migrates it.

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
| Recovery-proven | pass/fail | recovery-point ID, exact protected procedure, restore-drill evidence |
| Live-proven | pass/fail | fresh-install, chat, agent, restart evidence |
