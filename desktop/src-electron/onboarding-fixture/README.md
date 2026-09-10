# Joined onboarding fixture boundaries

This directory exercises the actual packaged renderer and native account,
recovery, business-provisioning and first-job paths against a fresh local relay.
It is test infrastructure, not an alternative onboarding implementation.

`proxy.mjs` forwards the original HTTP/WSS request, including canonical URL
authority, Host, authorization, payload and WebSocket frames. Account responses,
community creation and relay events come from the real relay. The proxy's only
destinations are explicit ephemeral loopback upstream listeners. Its observation
list retains method, exact fixture host, path without query and response status;
it does not retain headers or bodies.

The fixture relay requires membership and authenticated HTTP requests
(`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`, `BUZZ_REQUIRE_AUTH_TOKEN=true`) and permits
the existing signed owner-delegation path (`BUZZ_ALLOW_NIP_OA_AUTH=true`). A
separate synthetic deployment operator satisfies the relay's startup requirement
and is bootstrapped only in the bootstrap tenant. The synthetic customer remains
a different identity: its business ownership comes from actual provisioning,
and its agents are admitted through real NIP-OA authorization and explicit
Welcome channel enrollment. The fixture does not insert customer or agent
membership rows or replace relay-signed ownership snapshots.

The native `onboarding-fixture` Cargo feature is non-default and requires explicit
process configuration. It maps only the exact `.invalid` fixture hosts to the
proxy's ephemeral loopback port and trusts only this run's public CA. Initial
destinations are validated, redirects are disabled, and neither public roots nor
ambient proxies supply a fallback. Canonical URLs remain unchanged, including
NIP-98 signatures and the stored business WSS address. Normal beta builds do not
enable the feature.

Chromium uses exact host-resolver mappings and an exact leaf SPKI exception. The
SPKI switch **bypasses Chromium certificate verification for the matching key**;
it is not evidence of Chromium CA or hostname verification. Certificate creation
independently verifies the issuer signature, validity and exact DNS SAN list;
the proxy refuses mismatched Host/SNI. Native transport tests separately prove
real CA and hostname verification. No system trust store or DNS setting changes.
The launcher must also deny unapproved network origins using Electron
`session.webRequest`: literal IP requests bypass DNS rules. That guard cancels
requests and must never substitute successful account or provisioning responses.

The save-dialog selection seam is also compiled only with the fixture feature.
`BUZZ_ONBOARDING_FIXTURE_RECOVERY_PATH` must name `colony-recovery-code.txt` inside
the existing canonical `COLONY_ELECTRON_USER_DATA` directory. Selection does not
write a file or clear state. The real native registered-attempt checks, exclusive
0600 export writer, and subsequent UI acknowledgement remain in use.

`completeFixtureOnboarding` accepts the guarded page/relaunch callback and uses
the actual Account, Recovery and Business screens. It checks recovery persistence
across process relaunch, actual export contents and permissions, pending-state
clearance, canonical native relay selection, private Welcome and the real
owner-signed suggestion root. It returns the root and its canonical payload for
the worker half. Screenshots mask the recovery code. The caller owns app, relay,
proxy and temporary-profile cleanup even when an assertion fails.

Independent component gates:

```sh
node --test desktop/src-electron/onboarding-fixture/proxy.test.mjs
# Real HTTPS/WSS integration requires the installed Chromium binary.
pnpm -C desktop exec playwright install chromium
node --test desktop/src-electron/onboarding-fixture/proxy.chromium.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml \
  --features electron-host,onboarding-fixture --lib \
  commands::onboarding_recovery::fixture::tests
```

The joined account-only gate is launched separately, after creating the explicit
`--onboarding-fixture --debug` package:

```sh
COLONY_SMOKE_APP="/absolute/path/Colony Onboarding Fixture.app" \
COLONY_SMOKE_RELAY_BINARY="/absolute/path/buzz-relay" \
COLONY_SMOKE_ADMIN_BINARY="/absolute/path/buzz-admin" \
COLONY_SMOKE_PROOF_DIR="/absolute/path/proof" \
node desktop/src-electron/onboarding-smoke.mjs --account-only
```

Use `--with-work` instead of `--account-only` for the complete gate. The new
GitHub `Native first-job proof` job builds the release fixture and pinned backing
services. All checks run on GitHub, not on the user's Mac.

The app creates the account, exports its real encrypted recovery checkpoint,
creates the business, reads the real Credits catalog in Power, and publishes the
canonical company profile. Before funding or approval, Scout is the only native
agent, there is no Task, and the provider has received no model calls. The driver
then seeds only the isolated ledger through the real operator CLI, displays the
actual proposed Sarah teammate, and clicks **Approve team and start**. It never
calls persona, worker, rank, membership or company-writing APIs to pre-staff the
business. Old manual preparation helpers are not part of this gate.

The actual signed approval and receipt identify the newly created worker.
Assertions check the owner-signed worker definition and managed heads, manager, role,
inherited provider/model, real channel membership, isolated live ACP processes,
signed owner instruction, worker output and Scout review. The canonical Task
must complete in both live panes and stay completed after reload, with one
logical Task, instruction, worker and approval receipt and no extra model turn.
The provider matches the exact own persona section against Scout’s unchanged
native built-in definition and the worker’s owner-signed definition. Both identities
are bound by their signed managed heads; no nonexistent built-in persona head is
fabricated. It never guesses from names or quoted message history. ACP presently derives
rank context only from employee30190, so absent model rank lines for this
managed-agent30177 path remain a documented product limitation.

## Hosted services and safety boundary

GitHub ARM macOS cannot supply the old nested Docker VM path. The explicit
`COLONY_FIXTURE_TOOLS` path selects runner-only native processes: PostgreSQL17.6,
Redis7.4.2 and MinIO at immutable commit07c3a429. `service-sources.json` pins the
source archives and Go1.24.7 compiler by published SHA256 or commit. The build
uses Go's public module checksum database; no latest images or server binaries
are downloaded. Each run has fresh data, loopback ports, owned process groups,
reverse cleanup receipts and binary hashes. PostgreSQL uses TCP only, avoiding
Unix socket path limits. Its real pgcrypto extension is built too.

MinIO is real. An ordinary signed S3 request creates its private bucket, and the
relay's conditional-write conformance and deletion-storage admission run as
usual. No admission flag is disabled. The original exact-host `.invalid` TLS
routing and private native CA remain in use. Chromium's private SPKI exception
is separately constrained by its request allowlist; it is not proof of normal
Chromium CA trust. No system DNS/trust changes, personal profiles, vendor
credentials, live accounts or payment providers are accessed.

The model responses and ledger funds are synthetic. Bundled CLI tools, native
signatures, relay authorization, metering, task transitions and process isolation
are real. This proves workflow wiring, not model quality, a paid subscription or
payment settlement. `account-proof.json` and screenshots carry that distinction.
Service startup, assertion and cleanup failures all fail the workflow. All
execution and validation run on GitHub, not on the user's Mac.

Official inputs: [PostgreSQL17.6](https://ftp.postgresql.org/pub/source/v17.6/),
[Redis hashes](https://github.com/redis/redis-hashes),
[Go downloads](https://go.dev/dl/), and
[MinIO source](https://github.com/minio/minio/tree/07c3a429bfed433e49018cb0f78a52145d4bedeb).

The relay retains its default owner HTTP quota. The completion observer reads
only this isolated database every two seconds. A single explicit retry is allowed
only for a bounded server-specified cooldown before any instruction or model work;
there is no quota override or blanket429 retry. Preparation readback retries for
30seconds and preserves the actual last assertion as its failure diagnostic.

The fixture explicitly sets the global `OPENAI_COMPAT_BASE_URL` to the canonical
business `/gateway/openai/v1` URL. The worker must inherit it; no individual
worker override is written. Isolation validates that SDK base before ACP replaces
it with the real local meter. Leaving a public vendor base would correctly fail
the private destination map. The proof checks gateway token minting and one
canonical gateway call per model response. This proves the configured provisioned
meter/gateway path, not an untouched default direct-provider address.

The launcher passes a short environment allowlist. It preserves the OS `HOME`
needed to find the real default macOS Keychain and the normal `TMPDIR` needed by
the browser's bounded Unix-socket path. The app directory, native profile name
and Keychain service are unique to the run; only those resources are removed.
It also permits the exact packaged `app.asar/dist/` asset prefix needed by the
existing `colony://app` protocol handler. No other file or network origin is
admitted. The proof records the executed app archive and native/service hashes,
redacted requests, the furthest completed stage and cleanup outcome.
Only BrowserWindows belonging to the launched fixture process are hidden, with
background throttling disabled so the real renderer can run without taking
focus or receiving the user's desktop interactions. Reload checks restore the
original canonical Welcome URL through ordinary navigation. After a failed
Start, a read-only diagnostic may import the exact loaded company repository
module and retain its public error code; it never replaces that repository,
intercepts its response, or changes saved work.

The unit proxy test rejects invalid fixture domains and upstreams without a
browser binary. The separate `proxy.chromium.mjs` integration runs headless
Chromium HTTPS/WSS, rejects an unknown host and wrong SPKI, refuses mismatched
Host/SNI, and checks redacted observation records. CI runs it explicitly in
Desktop Smoke E2E shard 1 after Chromium and its system dependencies are installed;
Desktop Core unit discovery does not include it. Recovery selection tests reject
outside-profile paths and escaping directory symlinks.
These component checks do not establish the joined packaged result, hosted
signup availability, model quality, real payment or a production release.
