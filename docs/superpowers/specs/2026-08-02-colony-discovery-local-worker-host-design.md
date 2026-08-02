# Colony Discovery Local Worker Host Design

**Date:** 2026-08-02
**Status:** Approved for implementation planning
**Branch:** `codex/discovery-next`

## Goal

Add the smallest device-local Discovery worker to Colony by reusing Buzz's
existing OS keychain, Tauri lifecycle, Nostr identity, relay client, and the
already-proven Discovery worker protocol. This phase proves that a queued
Discovery run can be claimed and completed locally without exposing a customer
credential or contacting an external provider.

This is an extension of the fork, not a new credential or job system.

## Existing foundations we reuse

Colony already has the required platform capabilities:

- `SecretStore` stores a shared, atomic JSON secret blob in the OS keychain,
  distinguishes missing credentials from an unavailable keychain, verifies
  writes against the OS backend, and serializes cross-process mutations.
- `AppState` owns the active workspace, human signing identity, relay client
  state, and long-lived native background tasks.
- Tauri commands provide the existing native-to-React boundary.
- Colony already masks secret-shaped build configuration and excludes agent
  private keys, environment credentials, and provider configuration from relay
  snapshots.
- Discovery kinds `40019` and `40020` already provide private signed worker
  actions and relay-authored receipts with leases, checkpoints, fencing,
  cancellation, revocation, and restart recovery.

No second keychain, encrypted file, browser database, sidecar process, HTTP
service, or Supabase component will be introduced.

## Scope

This phase adds:

1. one namespaced Outscraper credential entry in the existing `SecretStore`;
2. native save, status, and delete commands that never return the stored value;
3. a stable, non-secret local worker installation ID;
4. a Tauri-owned background worker that uses the current human identity and
   active workspace relay;
5. a fake provider adapter that exercises credential loading, checkpointing,
   heartbeats, completion, cancellation, revocation, and restart recovery;
6. native and real-relay tests proving the boundary.

Only Outscraper receives a credential slot now. LLM credentials remain out of
scope until a qualification adapter and supported provider are selected. This
avoids inventing an LLM vendor commitment or a meaningless generic API-key
field.

## Credential behavior

The secret is stored under a fixed Discovery-specific key name inside the
existing keychain blob. It has no plaintext file or environment-variable
fallback. A keychain outage fails closed.

The native command surface is deliberately one-way:

- **Save or replace:** accepts a trimmed non-empty value, stores it, verifies
  the durable OS-keychain value, and returns only `configured`.
- **Status:** returns `configured`, `missing`, or `unavailable`; it never loads
  the value across Tauri IPC.
- **Delete:** removes the entry idempotently and returns `missing`.

Saving a credential makes no provider request. Authentication is first tested
when a future real provider run begins, so configuration alone cannot cause
vendor usage.

The credential necessarily exists briefly in the password input and the save
command argument. React must not persist it, log it, cache it, put it in a query
key, or receive it back after saving. The input is cleared after the command
settles. Agents, chat, relay events, database rows, and Discovery projections
never receive the value.

## Worker architecture

The worker is a native Rust task owned by the desktop application. It is not an
agent and does not depend on the Lead Specialist. UI and agent-created runs
therefore enter the same relay queue and use the same worker.

The host has four small responsibilities:

1. **Credential access:** check the Outscraper entry before claiming work and
   load it only inside native Rust when an adapter needs it.
2. **Relay protocol client:** sign claim, heartbeat, checkpoint, and complete
   actions with the current human identity; submit them to the active relay;
   and strictly parse the matching relay-signed receipt.
3. **Lease supervisor:** heartbeat while an adapter is active, abort execution
   on `LostLease`, and treat app/workspace shutdown as a recoverable lease
   expiry.
4. **Adapter runner:** execute one claimed run at a time and resume from the
   relay-provided checkpoint.

The worker installation ID is random, non-secret, and stable for the local app
installation. It is stored with other local application state, not in the
keychain and not in the relay as an independent record. It appears only where
the existing worker protocol requires it.

The host starts only after a usable workspace and signing identity exist. It
stops on sign-out, recovery mode, or app shutdown and restarts across an active
workspace change. It does not copy credentials between devices or communities.

The fake host is also guarded by
`BUZZ_DISCOVERY_FAKE_LOCAL_WORKER_ENABLED`. The flag defaults to false and must
equal `1` or `true` to start the task. Normal development, release, and customer
builds therefore cannot claim or complete paid runs with fixture results. The
flag is a proof-only bridge and is removed when the real Outscraper adapter
becomes the production implementation.

## Fake provider adapter

The fake adapter proves the local execution machinery without network access.
It requires the Outscraper credential to be present, borrows it inside native
memory, and immediately drops it without recording or echoing it.

It is available only when the explicit fake-worker flag is enabled. The adapter
contains no HTTP client, provider URL, or network dependency, making external
provider traffic impossible by construction.

For a fresh lease it emits the existing deterministic non-secret checkpoints:

1. `provider_submitted` with a fixture-safe opaque request ID;
2. `provider_results_ready` with a bounded fixture count;
3. `complete`.

When a reclaimed lease includes a checkpoint, the adapter resumes after that
boundary rather than replaying earlier work. A test pause can hold execution
between boundaries so cancellation, entitlement revocation, heartbeat, crash,
and restart behavior can be proven deterministically.

The adapter interface is internal and narrow. The real Outscraper adapter in
the following phase will replace only the adapter implementation, not the
credential, lifecycle, relay, or lease boundaries.

## Data flow

1. A user or capable agent creates a paid Discovery run through the existing
   relay operation.
2. The desktop worker confirms that the OS keychain is reachable and the
   Outscraper key exists.
3. The worker signs a claim with the active human identity.
4. The relay returns a private signed lease receipt and the latest checkpoint.
5. The worker loads the key only inside native Rust and runs the fake adapter.
6. Each durable boundary is signed and checkpointed through the relay.
7. A heartbeat returning `LostLease` cancels the adapter immediately.
8. A current worker completes the run through the relay.
9. After a crash or restart, a later claim resumes from the relay checkpoint.

If the credential is missing or the keychain is unavailable, the worker does
not claim a run. This prevents a paid run from entering a lease it cannot
execute. The future production UI and agent error surface will use the same
safe credential status before starting a real run.

## Errors and privacy

- Missing and unavailable are distinct states; neither includes backend error
  details or credential bytes.
- Empty credentials are rejected before storage.
- Keychain write success requires raw OS-backend read-back verification.
- The worker never falls back to plaintext storage.
- Relay rejection, receipt timeout, invalid relay signatures, and workspace
  changes stop the current attempt without completing it.
- Cancellation and entitlement revocation surface as `LostLease` and abort the
  adapter before another boundary begins.
- Logs may contain provider name, worker ID, run ID, operation, and a safe
  correlation ID. They may not contain command bodies, secret values, provider
  response bodies, or full keychain errors.
- A crash can leave an external lease active only until its existing expiry;
  the next worker reclaims through the proven fencing protocol.

## UI boundary

This phase adds the safe native commands and TypeScript API contract but does
not redesign or wire the Discovery Settings screen. The fixture-backed demo UI
continues unchanged. Connecting the existing Settings surface belongs with the
real Outscraper adapter so configuration and first-use errors can be proven as
one customer-visible flow.

## Excluded

- real Outscraper, LLM, Exa, Brave, or other provider calls;
- LLM provider selection or qualification credentials;
- provider authentication validation during credential save;
- production `DiscoveryDataSource` wiring or native Discovery UI changes;
- enabling the fake worker in normal or release builds;
- Campaign, Business, observation, deduplication, Lead, or usage persistence;
- People discovery;
- agent-specific execution paths;
- credential synchronization, export, plaintext fallback, or relay storage;
- pricing, checkout, Colony usage credits, or vendor resale.

## Acceptance gate

This phase is complete only when all of the following are proven:

1. The existing `SecretStore` is reused; no second credential store exists.
2. Native save, status, and delete operations expose only safe status values.
3. Empty input is rejected, deletion is idempotent, and missing differs from an
   unavailable keychain.
4. A real OS-keychain test saves, raw-verifies, probes, loads internally, and
   deletes the Outscraper entry without returning it through Tauri IPC.
5. No provider network request occurs during save, status, delete, or the fake
   adapter run.
6. The stable worker ID survives a desktop-host restart but remains non-secret.
7. The fake worker defaults off, accepts only an explicit `1` or `true` opt-in,
   and sends zero worker actions when disabled.
8. With a real relay and database, the native host claims an eligible run,
   heartbeats, writes both checkpoints, and completes it through the fake
   adapter.
9. A missing or unavailable credential causes zero claim actions.
10. Killing the host after `provider_submitted` and starting a new host reclaims
   at attempt 2 and resumes without repeating that checkpoint.
11. Cancellation and entitlement revocation during a paused fake step abort
    execution, produce no later checkpoint, and reject stale completion.
12. A fixture secret appears zero times in serialized command results, logs,
    relay events, and Discovery database rows.
13. Focused tests and the full `just ci` repository gate pass.

Implemented, locally tested, committed, merged, deployed, and customer-proven
remain separate states.

## Recommended following phase

After this gate passes, implement the real Outscraper Businesses adapter and
wire the existing Discovery Settings surface to the safe credential commands.
That phase will prove real authentication, asynchronous provider polling,
normalization, bounded usage, and customer-visible errors without changing the
worker host or secret-storage architecture.
