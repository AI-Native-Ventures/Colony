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

Use `--with-work` instead of `--account-only` for the complete gate. After the
real account/business path and zero-credit check, the fixture owner approves a
company profile with `buzz company put`. The existing admin CLI then adds five
fixture dollars to the isolated ledger. Before any worker approval, the actual
Start must show the unavailable-worker state with its retry action, preserve the
shared brief, and create no Task, instruction or model call. The fixture then
approves the native personas and team and enrolls both stopped agents. This is
balance/gateway proof, not a payment-settlement test. The normal Start control
must create the canonical Task,
start both real ACP processes, and produce the worker's signed output and the
Chief of Staff's review/completion report in the same thread. Reload must retain
one Task and one initial instruction. Before any reload, both visible cards must
show `Completed` within 30 seconds of the verified current relay head and the
Chief's finished review turn. A completed relay record with a stale live card
fails this gate; persistence after reload alone does not pass it. Separate,
distinct screenshots capture the returned work and the completed state after
reload.

The relay keeps its default owner HTTP limit of 300 calls per minute. After
rapid fixture approval and readback, the driver waits one 60-second admission
window before both the unstaffed check and staffed Start, verifying no saved
attempt, instruction or model work during setup. The unstaffed window also
checks zero Task records before and after. Its completion wait observes actual
persisted Task status through read-only SQL every two seconds;
it does not publish or substitute state. The provider's command preparation and
final completion checks still fetch and verify the real relay-signed Task head.
This avoids the test observer competing with normal app queries for that quota;
there is no quota override or blanket retry of HTTP 429 responses.

The provider supplies deterministic model responses; its shell tools execute the
real bundled CLI, including canonical Task/team tags. A refusal, failed tool,
missing signed head, or unavailable approved team fails the gate. The proof
records public staffing evidence, model stages and tool commands, exact fixture
script hashes, and separate account/work completion fields. Fixture approval does
not establish that a new production business is automatically staffed.
The fixture explicitly approves each agent's `OPENAI_COMPAT_BASE_URL` as the
canonical business `/gateway/openai/v1` URL. Isolation validates that SDK base
before ACP replaces it with the real local meter; leaving the public vendor
default would correctly fail the fixture's private destination map. No vendor
host is redirected or allowed. The proof retains the approved public base and
checks gateway token minting plus a matching canonical gateway request for every
model response. This proves the configured provisioned-meter/gateway path, not
an untouched default provider base.

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
