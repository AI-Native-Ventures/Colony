# Colony Operator Analytics Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved, deployment-wide Colony operator portal as a
read-only operational surface. It must show identity population,
memberships, meaningful activity, daily DAU/WAU/MAU history, and
deployment-wide live sessions without treating PostHog, a single relay pod, or
the current users row as stronger evidence than they are.

**Architecture:** Extend the existing first-party admin-web package and relay
operator namespace. A shared Postgres read model stores rebuildable daily
activity aggregates and per-community rollup cursors. A shared Redis lease
store is the authority for fresh authenticated WebSocket sessions across pods.
NIP-98 request signing, replay protection, the configured operator origin, and
RELAY_OPERATOR_PUBKEYS remain the only analytics authority boundary. The HTTP
API returns a common freshness envelope and metadata-only field allowlist; the
web portal renders that contract with no message/event content.

**Tech Stack:** Rust, axum, Tokio, sqlx/Postgres, Redis/deadpool-redis,
Nostr NIP-98/NIP-07/NIP-46 signer interfaces, React 19, Vite, TypeScript,
Biome, Vitest, and Playwright.

---

## Source of truth and execution shape

The approved product and privacy contract is
docs/superpowers/specs/2026-08-09-colony-operator-analytics-portal-design.md.
This plan is one master plan because the relay, read model, API envelope, and
portal filters must land as one compatible contract. It is deliberately
divided into three independently testable workstreams:

1. Relay and data plane: Postgres rollups, Redis leases, authentication
   lifecycle, and the rollup worker.
2. Operator API: typed filters, source freshness, access logging, and
   deployment-wide queries.
3. Admin web: signer adapter, API client, Command Center, drill-down pages,
   and browser proof.

The workstreams may be delegated after Task 1, but each gate below must pass
before its dependants are merged.

### Locked v1 decisions

- The portal is read-only. It adds no suspension, membership, archive,
  mutation, or export route.
- PostHog is not a v1 dependency and never defines people, memberships,
  activity, or live sessions.
- Analytics routes live under /operator/analytics, outside the
  host/origin-only /api/admin/v1 router.
- Every analytics request is NIP-98 signed against the exact configured
  RELAY_OPERATOR_API_ORIGIN URL and exact HTTP method. There is no host-only
  or X-Pubkey fallback.
- The replay namespace for analytics is operator-analytics; existing
  community-management routes retain operator-management.
- Dates and rollups use UTC. The UI labels “First seen” and “New memberships”;
  it never calls a materialized users row a product signup.
- Unique people are distinct pubkeys. Memberships are active relay_members
  rows and remain a separate count.
- DAU/WAU/MAU count distinct pubkeys with an accepted event in the pinned
  activity-family allowlist. Presence, typing, auth, transport heartbeats,
  profile refreshes, and relay-only sidecars do not qualify.
- Live cards distinguish online people, authenticated sessions, and raw open
  WebSocket connections. Online people deduplicate the same pubkey across
  communities, pods, and connections; sessions and connections do not.
- Responses contain profile/activity metadata only. They never contain event
  content, signed payloads, private keys, provider credentials, client-local
  provider/model settings, or full remote addresses.
- Redis failure marks live data unavailable. It never silently substitutes one
  pod's ConnectionManager counts for deployment-wide values.
- Every attributable analytics request produces a deployment-global access
  record. The existing per-community hash-chain audit log is not reused.

## File map

### Relay and database

- Create: migrations/0057_operator_analytics.sql
- Modify: schema/schema.sql
- Modify: crates/buzz-db/src/lib.rs
- Create: crates/buzz-db/src/operator_analytics.rs
- Modify: crates/buzz-db/src/migration.rs
- Create: crates/buzz-pubsub/src/operator_sessions.rs
- Modify: crates/buzz-pubsub/src/lib.rs
- Modify: crates/buzz-relay/src/config.rs
- Modify: crates/buzz-relay/src/state.rs
- Modify: crates/buzz-relay/src/connection.rs
- Modify: crates/buzz-relay/src/handlers/auth.rs
- Create: crates/buzz-relay/src/operator_analytics.rs
- Modify: crates/buzz-relay/src/lib.rs
- Modify: crates/buzz-relay/src/main.rs

### Operator API

- Create: crates/buzz-relay/src/api/operator_auth.rs
- Create: crates/buzz-relay/src/api/operator_analytics.rs
- Modify: crates/buzz-relay/src/api/mod.rs
- Modify: crates/buzz-relay/src/api/operator.rs
- Modify: crates/buzz-relay/src/router.rs

### Admin web

- Create: admin-web/src/analytics/types.ts
- Create: admin-web/src/analytics/operatorAuth.ts
- Create: admin-web/src/analytics/api.ts
- Create: admin-web/src/analytics/hooks.ts
- Create: admin-web/src/analytics/AnalyticsLayout.tsx
- Create: admin-web/src/analytics/OverviewPage.tsx
- Create: admin-web/src/analytics/CommunitiesPage.tsx
- Create: admin-web/src/analytics/PeoplePage.tsx
- Create: admin-web/src/analytics/PersonDetailPage.tsx
- Create: admin-web/src/analytics/ActivityPage.tsx
- Create: admin-web/src/analytics/SessionsPage.tsx
- Create: admin-web/src/analytics/DefinitionsPage.tsx
- Create: admin-web/src/analytics/components.tsx
- Create: admin-web/src/analytics/operatorAuth.test.ts
- Create: admin-web/src/analytics.css
- Create: admin-web/src/window.d.ts
- Create: admin-web/tests/analytics.spec.ts
- Modify: admin-web/src/App.tsx
- Modify: admin-web/src/main.tsx

### Operations and proof

- Modify: crates/buzz-admin/src/main.rs
- Create: docs/admin/operator-analytics.md
- Modify: docs/admin/README.md
- Modify: .env.example
- Create: crates/buzz-test-client/tests/e2e_operator_analytics.rs

## Task 1: Freeze the shared contract and activity definitions

**Files:**

- Create: crates/buzz-db/src/operator_analytics.rs
- Modify: crates/buzz-db/src/lib.rs
- Create: crates/buzz-relay/src/api/operator_auth.rs
- Modify: crates/buzz-relay/src/api/mod.rs
- Modify: crates/buzz-relay/src/api/operator.rs
- Create: admin-web/src/analytics/types.ts
- Create: admin-web/src/window.d.ts
- Create: docs/admin/operator-analytics.md

**Interfaces to lock:**

- Rust constant OPERATOR_ANALYTICS_DEFINITIONS_VERSION: &str = "v1".
- Rust ActivityFamily enum with serialized values message, thread, reaction,
  channel, command, workflow, git, and huddle.
- Rust FreshnessStatus values fresh, stale, and unavailable.
- Rust AnalyticsEnvelope<T> fields: data, as_of, freshness,
  definitions_version, and warnings.
- TypeScript equivalents for the envelope and every metadata-only response
  row. The TypeScript types must not declare content, sig, tags, payload,
  provider, model, or remote_addr fields.
- OperatorSigner:

  ~~~typescript
  export type UnsignedNip98Event = {
    kind: 27235;
    created_at: number;
    tags: string[][];
    content: "";
  };

  export type SignedNip98Event = UnsignedNip98Event & {
    id: string;
    pubkey: string;
    sig: string;
  };

  export interface OperatorSigner {
    readonly source: "nip07" | "nip46";
    getPublicKey(): Promise<string>;
    signEvent(event: UnsignedNip98Event): Promise<SignedNip98Event>;
  }
  ~~~

  window.nostr is the NIP-07 source. window.colonyOperatorSigner is the
  NIP-46/remote signer bridge supplied by the hosting shell; neither interface
  exposes a private key to the page.

**Pinned activity map:**

- message: KIND_TEXT_NOTE, all stream message kinds
  KIND_STREAM_MESSAGE through KIND_STREAM_MESSAGE_DIFF, KIND_CANVAS, and the
  four KIND_DM_* kinds.
- thread: KIND_FORUM_POST, KIND_FORUM_COMMENT, and stream/message events whose
  stored event is linked to thread_metadata.root_event_id or carries a valid
  thread e tag.
- reaction: KIND_REACTION and KIND_FORUM_VOTE.
- channel: NIP-29 user/group/admission commands KIND_NIP29_PUT_USER,
  KIND_NIP29_REMOVE_USER, KIND_NIP29_EDIT_METADATA,
  KIND_NIP29_DELETE_EVENT, KIND_NIP29_CREATE_GROUP,
  KIND_NIP29_DELETE_GROUP, KIND_NIP29_CREATE_INVITE,
  KIND_NIP29_JOIN_REQUEST, KIND_NIP29_LEAVE_REQUEST, the moderation command
  range KIND_MODERATION_BAN through KIND_MODERATION_RESOLVE_REPORT,
  hire/archive/unarchive commands, and the NIP-43 membership commands.
- command: Block, company, party, discovery, discovery-worker,
  discovery-workspace, and ledger action kinds; job request/accept/progress/
  result/cancel/error kinds; job filing/claim/outcome kinds; and the interrupt
  ask/resolution/withdrawal/decision kinds. KIND_JOB_HEARTBEAT, receipts,
  usage records, and agent-turn metrics remain excluded.
- workflow: all user or relay accepted workflow trigger, approval, and
  lifecycle kinds in the 46000 range. The definitions response records the
  exact constants, including whether the author is normally a relay or client.
- git: all existing NIP-34 repository, patch, pull-request, issue, and status
  kinds.
- huddle: KIND_HUDDLE_STARTED, KIND_HUDDLE_PARTICIPANT_JOINED,
  KIND_HUDDLE_PARTICIPANT_LEFT, KIND_HUDDLE_ENDED, and
  KIND_HUDDLE_GUIDELINES.
- Any kind not in the map is excluded. The definitions response explicitly
  lists the transport/noise exclusions: profile and metadata synchronization,
  NIP-42/NIP-98 auth, Blossom auth, identity binding, presence, typing,
  observer frames, huddle reaction bursts, relay-only summaries/snapshots,
  system messages, member notifications, and all other unlisted kinds.

**Steps:**

- [ ] Add pure ActivityFamily parsing and classify_activity(kind, tags,
  has_thread_metadata) tests. Assert every pinned kind maps to exactly one
  family, every excluded kind returns None, thread classification is
  deterministic, and the definitions version is v1.
- [ ] Extract the current operator NIP-98 helper from api/operator.rs into
  api/operator_auth.rs. Give it a scope: &'static str parameter, preserve the
  canonical origin, verify_bridge_auth_with_options call, timestamp
  validation, exact URL binding, and fail-closed replay guard. Update
  management routes to pass operator-management; analytics will pass
  operator-analytics.
- [ ] Add the serialized Rust envelope and TypeScript response types. Keep the
  TypeScript types as an explicit allowlist rather than using
  Record<string, unknown>.
- [ ] Document the definitions, field allowlist, freshness states, signer
  bridge contract, and no-PostHog boundary in
  docs/admin/operator-analytics.md.
- [ ] Run:
  . ./bin/activate-hermit && cargo test -p buzz-db operator_analytics --lib
  and pnpm --dir admin-web typecheck.
  Expected result: the new pure taxonomy/type tests pass and the existing
  operator tests still pass after the auth helper move.

**Gate 1:** The API and web types compile from the same definitions version;
management auth behavior is unchanged; the activity map has no implicit
fallback family.

## Task 2: Add the Postgres read model and schema-lint coverage

**Files:**

- Create: migrations/0057_operator_analytics.sql
- Modify: schema/schema.sql
- Modify: crates/buzz-db/src/migration.rs

**Schema:**

Create the tenant-scoped derived table:

~~~sql
CREATE TABLE operator_activity_daily (
    community_id        UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    utc_day             DATE NOT NULL,
    pubkey              BYTEA NOT NULL CHECK (length(pubkey) = 32),
    activity_family     TEXT NOT NULL CHECK (
        activity_family IN (
            'message', 'thread', 'reaction', 'channel',
            'command', 'workflow', 'git', 'huddle'
        )
    ),
    event_count         BIGINT NOT NULL CHECK (event_count > 0),
    first_activity_at   TIMESTAMPTZ NOT NULL,
    last_activity_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (community_id, utc_day, pubkey, activity_family),
    CHECK (first_activity_at <= last_activity_at)
);
~~~

Add these non-unique indexes:

- operator_activity_daily_day_idx on (community_id, utc_day).
- operator_activity_daily_person_idx on (community_id, pubkey, utc_day).
- operator_activity_daily_deployment_idx on (utc_day, pubkey, community_id)
  for deployment-wide distinct-person aggregation.

Create the per-community cursor:

~~~sql
CREATE TABLE operator_activity_cursor (
    community_id         UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    last_created_at       TIMESTAMPTZ,
    last_event_id         BYTEA CHECK (last_event_id IS NULL OR length(last_event_id) = 32),
    definitions_version   TEXT NOT NULL CHECK (definitions_version = 'v1'),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (community_id),
    CHECK ((last_created_at IS NULL) = (last_event_id IS NULL))
);
~~~

Create the deployment-global access log and register it in
_operator_global_tables:

~~~sql
CREATE TABLE operator_access_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id      UUID NOT NULL,
    operator_pubkey BYTEA NOT NULL CHECK (length(operator_pubkey) = 32),
    route           TEXT NOT NULL,
    filter_digest   BYTEA CHECK (filter_digest IS NULL OR length(filter_digest) = 32),
    target_digest   BYTEA CHECK (target_digest IS NULL OR length(target_digest) = 32),
    outcome         TEXT NOT NULL CHECK (
        outcome IN ('success', 'invalid_filter', 'source_error', 'forbidden')
    ),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO _operator_global_tables (table_name, reason) VALUES
    ('operator_access_log', 'deployment-wide operator accountability; filter and target values are stored only as digests');
~~~

Do not add a Redis session table or a raw event-content projection.

**Steps:**

- [ ] Write migration-lint tests in crates/buzz-db/src/migration.rs before
  the migration: update the embedded migration count from 45 to 46; assert
  migration 46 creates all three tables, registers only operator_access_log
  as global, and keeps both derived tables tenant leading.
- [ ] Add migrations/0057_operator_analytics.sql with the exact definitions
  above, indexes, foreign keys, checks, and global-table registry insert.
- [ ] Mirror the final schema, indexes, checks, and registry row in
  schema/schema.sql. Keep the schema mirror equivalent in column names and
  constraint meaning, not merely table names.
- [ ] Extend the fresh-database migration test to assert the three new tables,
  the access-log registry row, and the operator_activity_daily primary key
  order. Run the existing tenant-leading constraint and schema mirror tests.
- [ ] Run:
  . ./bin/activate-hermit && cargo test -p buzz-db migration --lib
  Expected result: migration count is 46, all schema-lint tests pass, and no
  pre-existing migration checksum changes.

**Gate 2:** A fresh database and a brownfield database can apply migration 46;
the schema linter proves that no tenant table lacks a leading community_id;
the global registry contains only the access log among the new tables.

## Task 3: Implement rollup storage, backfill, and deployment-wide queries

**Files:**

- Create: crates/buzz-db/src/operator_analytics.rs
- Modify: crates/buzz-db/src/lib.rs

**DB interfaces:**

Add typed methods on Db, with doc comments, for:

- operator_activity_batch(community_id, cursor, limit): select only
  community_id, id, pubkey, created_at, kind, tags, channel_id, and thread
  metadata presence. It must never select events.content, sig, or the full
  event JSON.
- operator_rollup_batch(community_id, cursor, limit): in one Postgres
  transaction, lock the cursor row, fetch events ordered by (created_at, id),
  classify them, aggregate in memory by (utc_day, pubkey, activity_family),
  upsert daily rows with event_count = existing + batch_count, update
  first/last timestamps, advance the cursor even when every event in the batch
  is excluded, and commit all changes atomically.
- operator_rebuild_activity(community_id, start, end): acquire the same
  per-community advisory lock, scan the selected source range through the same
  batch fetch and classifier into a transaction-local staging table, replace
  the selected daily rows from that stage, and leave the live cursor unchanged
  when it is already past end. When the range reaches the live cursor, advance
  the cursor to the last source event in the range. This is the supported
  idempotent rebuild path; there is no second classifier or source query.
- operator_record_access(request_id, operator_pubkey, route, filter_digest,
  target_digest, outcome): insert the global access record.
- operator_overview, operator_communities, operator_people, operator_person,
  and operator_activity: return typed metadata structs for the API. The
  queries must use operator_activity_daily for historical windows and existing
  authoritative tables for users, memberships, channels, and thread metadata.

**Query semantics:**

- Identity population is the union of users, active relay_members, and rollup
  pubkeys in the selected scope. A missing users row is retained as unknown.
  A pubkey is excluded from the default population only when all known user
  rows for that pubkey are deactivated.
- first_seen is the minimum users.created_at for the pubkey across selected
  communities. A missing profile leaves it null; it is never inferred from a
  display event.
- Membership count is COUNT(*) over active relay_members rows.
- Human/agent/unknown uses the existing users.agent_owner_pubkey relation: a
  present row with a null owner is human, a present owner is agent, and a
  missing row is unknown.
- DAU/WAU/MAU are COUNT(DISTINCT pubkey) over qualifying rollup rows in the
  UTC 1-day, 7-day, and 30-day windows. The all-time view uses the full daily
  rollup range.
- Activity volume and unique people use the daily rollup; channels and thread
  counts use channels, channel_members, and thread_metadata.
- People results sort by first_seen DESC NULLS LAST, pubkey ASC. Person detail
  identifies the target by exactly 64 lowercase hex characters and returns the
  same profile allowlist used by the directory.
- All list methods accept a bounded limit of 1 to 200 and an opaque cursor.
  The cursor encodes the last sort tuple and is rejected when malformed or
  paired with a different filter digest.

**Rollup correctness rules:**

- Serialize each community with pg_advisory_xact_lock and SELECT ... FOR
  UPDATE on operator_activity_cursor. Multiple relay pods may run the same
  worker without double counting.
- The transaction boundary is the idempotency boundary. A crash before commit
  rolls back the daily upsert and cursor; a committed batch cannot be selected
  again by that cursor. Rebuild deletes and replays the same source range.
- The rollup watermark reports the last source event timestamp and ID, not
  the worker wall clock. A worker with no qualifying events still advances the
  source cursor.
- Queries use UTC day boundaries and never compare naive local timestamps.

**Steps:**

- [ ] Add failing unit tests for the activity classifier and cursor ordering:
  same timestamp uses the lowest event ID first, excluded events advance the
  cursor, and thread-tagged stream messages map to thread.
- [ ] Add Postgres integration tests, marked requires Postgres, covering one
  qualifying and one excluded event; same pubkey in two communities;
  human/agent/unknown joins; two executions of the same rebuild producing
  identical daily rows; and a cursor crash simulation that leaves no partial
  upsert.
- [ ] Implement the typed batch, additive runtime upsert, cursor, staged range
  rebuild, access-log, and query methods. Use sqlx::query runtime statements
  and map all database errors to DbError; do not add production unwrap() or
  expect().
- [ ] Add serialization tests that convert every API row to JSON and assert
  the keys never contain content, sig, tags, payload, provider, model, or
  remote_addr.
- [ ] Run:
  . ./bin/activate-hermit && cargo test -p buzz-db operator_analytics --lib
  Expected result: pure tests pass; ignored tests are listed but remain unrun
  when Postgres is unavailable.
- [ ] With Postgres configured, run:
  . ./bin/activate-hermit && cargo test -p buzz-db operator_analytics --lib -- --ignored
  Expected result: rollup and query fixtures pass with identical rebuild
  totals.

**Gate 3:** Exact source queries and derived queries agree for the fixture
deployment; rebuild is idempotent; excluded transport noise cannot enter a
daily row; no database method can return event content.

## Task 4: Add shared Redis session leases

**Files:**

- Create: crates/buzz-pubsub/src/operator_sessions.rs
- Modify: crates/buzz-pubsub/src/lib.rs
- Modify: crates/buzz-relay/src/state.rs

**Redis contract:**

Use a single deployment-wide sorted-set index and per-session hashes:

- Index: buzz:operator:sessions:index, member
  <community_uuid>:<connection_uuid>, score = last-seen epoch milliseconds.
- Hash: buzz:operator:sessions:<community_uuid>:<connection_uuid>.
- Hash fields: pubkey, started_at, last_seen_at, pod_id, network_cidr, and
  client_label. No raw IP and no event payload.
- TTL: PRESENCE_TTL_SECS = 90. The index is pruned by score before every
  list/count operation; the hash TTL remains the crash-safe authority.

Add OperatorSessionStore methods:

- register(lease): write hash, set 90-second expiry, and add the index member
  atomically.
- refresh(community_id, connection_id, now): refresh only an existing hash,
  update last_seen_at, refresh TTL, and update the index score.
- clear(community_id, connection_id): delete the hash and remove its index
  member.
- list(scope, cursor, limit): prune expired scores, read active members with
  stable (last_seen_at DESC, member ASC) cursor semantics, filter by optional
  community, and hydrate hashes. Return at most 200 rows.
- counts(scope): return raw connections, authenticated sessions, and distinct
  pubkeys across all hydrated rows, grouped by optional community filter.

Use a Lua script or one Redis transaction for register/refresh/clear so a
crash cannot leave a newly registered hash absent from the index or a deleted
hash in the active index. The list implementation must remove missing hashes
from the index and must not use KEYS.

Derive network_cidr once at registration:

- IPv4: zero the last octet and append /24.
- IPv6: retain the first 64 bits and append /64.
- Invalid/absent socket address: store null.

**Steps:**

- [ ] Add pure tests for key format, IPv4/IPv6 masking, cursor ordering,
  same pubkey across two communities, and duplicate connections.
- [ ] Add ignored Redis tests covering register, refresh, clean clear, TTL
  expiry, stale index pruning, two independent store handles, and Redis
  failure errors.
- [ ] Add operator_sessions: Arc<OperatorSessionStore> to AppState,
  initialize it from the existing Redis pool, and keep the store scoped to
  deployment rather than community.
- [ ] Run:
  . ./bin/activate-hermit && cargo test -p buzz-pubsub operator_sessions --lib
  Expected result: pure tests pass.
- [ ] With Redis configured, run:
  . ./bin/activate-hermit && cargo test -p buzz-pubsub operator_sessions --lib -- --ignored
  Expected result: TTL and multi-handle tests pass.

**Gate 4:** A session created on one store handle is visible on another; the
same pubkey is counted once online and once per connection; a dead pod's
session disappears after 90 seconds without cleanup code.

## Task 5: Wire session lifecycle, pod identity, and the rollup worker

**Files:**

- Modify: crates/buzz-relay/src/config.rs
- Modify: crates/buzz-relay/src/state.rs
- Modify: crates/buzz-relay/src/connection.rs
- Modify: crates/buzz-relay/src/handlers/auth.rs
- Create: crates/buzz-relay/src/operator_analytics.rs
- Modify: crates/buzz-relay/src/lib.rs
- Modify: crates/buzz-relay/src/main.rs

**Lifecycle behavior:**

- Add operator_instance_id to Config. Resolve it from POD_NAME, then
  HOSTNAME, then a boot UUID generated during configuration parsing. The value
  is a label only; it is never an authority key.
- Add a lease only after the existing NIP-42 auth, ban, pubkey allowlist,
  relay-membership, and NIP-OA owner materialization checks succeed and after
  ConnectionManager::set_authenticated_pubkey.
- Pass the community, connection ID, socket address, instance ID, auth
  pubkey, and optional existing client label into register.
- Pass the store and lease identity into the heartbeat task. Every 30-second
  heartbeat refreshes the lease after the server sends its ping. A Redis
  refresh error is logged and counted but does not close a healthy socket; the
  90-second TTL makes the live card honest during Redis loss.
- On cleanup, clear the lease before deregistering the local connection. Keep
  the existing tenant-scoped presence cleanup and local metrics unchanged.
- Add a new operator_analytics runtime module with a 30-second worker:
  enumerate active communities, call the per-community transactional rollup
  batch with a maximum of 5,000 source events, and repeat until the batch is
  short. Use the Postgres advisory lock so every pod may run it safely.
  Expose a cancellation token and cancel it beside the existing lifecycle
  revalidator on shutdown.
- Emit metrics buzz_operator_rollup_lag_seconds,
  buzz_operator_rollup_batches_total,
  buzz_operator_session_refresh_errors_total, and
  buzz_operator_sessions_active without including pubkeys or network addresses
  in labels.

**Steps:**

- [ ] Add config parsing tests for POD_NAME, HOSTNAME, and the deterministic
  boot-UUID fallback. Confirm existing config validation for
  RELAY_OPERATOR_API_ORIGIN and RELAY_OPERATOR_PUBKEYS remains intact.
- [ ] Add lifecycle tests around the auth transition: failed auth never creates
  a lease; successful auth creates exactly one lease; a second connection for
  the same pubkey creates a second session but only one online person; cleanup
  clears the exact community/connection key.
- [ ] Implement registration in the success branch at
  crates/buzz-relay/src/handlers/auth.rs, refresh in the heartbeat call, and
  clear in connection.rs. Preserve the existing auth response ordering: the
  client receives the successful OK only after the in-memory auth state and
  lease registration have been attempted.
- [ ] Create the worker module, export it from crates/buzz-relay/src/lib.rs,
  and spawn/cancel it from main.rs after AppState exists.
- [ ] Run:
  . ./bin/activate-hermit && cargo test -p buzz-relay operator_analytics --lib
  Expected result: config, lifecycle, and worker unit tests pass.
- [ ] Run the focused relay build:
  . ./bin/activate-hermit && cargo check -p buzz-relay
  Expected result: the relay compiles with the new AppState field and
  lifecycle calls.

**Gate 5:** Authenticated sessions are deployment-wide, crash-safe, and
excluded from DAU/WAU/MAU. Rollup lag is measurable from the source cursor;
shutdown cancels the worker; local connection metrics remain unchanged.

## Task 6: Implement the read-only operator analytics API

**Files:**

- Create: crates/buzz-relay/src/api/operator_analytics.rs
- Modify: crates/buzz-relay/src/api/mod.rs
- Modify: crates/buzz-relay/src/api/operator.rs
- Modify: crates/buzz-relay/src/router.rs

**Routes:**

Register these GET routes on the existing deployment api_router:

- /operator/analytics/overview
- /operator/analytics/communities
- /operator/analytics/people
- /operator/analytics/people/{pubkey}
- /operator/analytics/activity
- /operator/analytics/sessions
- /operator/analytics/definitions

Every handler:

1. Extracts RawQuery and rejects unknown parameters with a
   serde(deny_unknown_fields) query type.
2. Caps limit at 200, validates UTC start/end order, validates one community
   UUID, validates human|agent|unknown, validates online=true|false, and
   rejects malformed cursors/pubkeys without echoing query values.
3. Calls the shared operator auth helper with the exact route and raw query,
   replay scope operator-analytics, and no body.
4. Computes SHA-256 digests of the canonical filter string and optional pubkey
   target. It never stores raw query or target text in the access log.
5. Runs the DB/Redis query, records success, invalid_filter, or source_error
   in operator_access_log, and returns a request ID. If the access-log insert
   fails, return 503 and do not return data.

**Response contract:**

- overview.data: scope, population with unique_people, memberships, first_seen,
  new_memberships; live with online_people, authenticated_sessions,
  open_connections; engagement with dau, wau, mau; trend daily points; and
  communities health rows.
- communities.data: rows containing community ID/host/name/status/created
  date, people, memberships, channels, threads, online people, DAU/WAU/MAU,
  activity volume, and last activity, plus next_cursor.
- people.data: rows containing shortened pubkey and full hex pubkey, profile
  label, NIP-05, avatar URL, human/agent/unknown type, community count,
  membership count, channel count, owned-agent count, first seen, last
  meaningful activity, online state, and next_cursor.
- people/{pubkey}.data: profile, memberships/roles, channels,
  thread-participation counts, activity-family totals/trend, and active session
  metadata.
- activity.data: daily points and family/type breakdowns with event counts and
  distinct people only. It never returns event IDs or payload fields.
- sessions.data: active lease rows with person/community, connection ID,
  started/last-seen timestamps, pod ID, coarse network CIDR, and client label
  only when that label already exists in the handshake. It includes
  online_people, authenticated_sessions, and open_connections.
- definitions.data: definitions version, metric formulas, UTC semantics,
  exact family-to-kind map, excluded kinds, identity classification, source
  tables, freshness semantics, and privacy exclusions.

**Freshness behavior:**

- Historical freshness is derived from the maximum per-community cursor
  watermark. Report stale with the cursor lag when it is older than the
  requested window end; do not label a lagging all-time query fresh.
- Live freshness is derived from the Redis observation timestamp. On Redis
  failure, return the historical data with live status unavailable and a
  warning. Never read ConnectionManager for an operator response.
- Definitions is always fresh because it is static code data.
- An empty scope returns zero-valued cards and an explicit empty state, not
  404. A missing person returns 404 only after authentication and filter
  validation.

**Steps:**

- [ ] Add API unit tests for unknown filters, limit 201, invalid dates,
  malformed cursor, malformed pubkey, exact canonical URL, no host-only
  fallback, and error responses that do not reveal target existence.
- [ ] Add NIP-98 endpoint tests using the existing operator test helpers for:
  allowlisted success, unallowlisted 403, stale timestamp 401, wrong URL 401,
  replay 401, management/analytics replay-scope separation, and Redis replay
  guard failure fail-closed. A verified but unallowlisted request must also
  produce an access-log row with outcome forbidden; an unverifiable request
  must not reveal whether a target exists.
- [ ] Add ignored Postgres/Redis handler tests for distinct people versus
  memberships, three active-session cards, stale rollup envelope, Redis
  unavailable envelope, and partial overview responses.
- [ ] Implement the handlers, route registration, typed query parsing, response
  envelope, X-Request-Id response header, access logging, and source-failure
  aggregation.
- [ ] Add a privacy regression test that serializes every route response and
  asserts none of the forbidden content, secret, provider/model, or full-IP
  keys occur.
- [ ] Run:
  . ./bin/activate-hermit && cargo test -p buzz-relay operator_analytics --lib
  and . ./bin/activate-hermit && cargo check -p buzz-relay.
  Expected result: route/auth tests pass and the full relay API compiles.

**Gate 6:** The API is NIP-98-only, read-only, bounded, privacy-safe, and
honest about Redis/rollup freshness. It cannot accidentally route through
/api/admin/v1 or a tenant host.

## Task 7: Add the signed admin-web API client

**Files:**

- Create: admin-web/src/analytics/operatorAuth.ts
- Create: admin-web/src/analytics/api.ts
- Create: admin-web/src/analytics/hooks.ts
- Create: admin-web/src/analytics/operatorAuth.test.ts
- Modify: admin-web/src/main.tsx

**Client behavior:**

- Keep the existing /api/admin/v1 request helper unchanged for reports and
  feedback.
- Add analyticsRequest<T>(path, signer, options) that constructs the exact
  same-origin URL, builds kind 27235 with u, method, and a fresh UUID nonce
  tags, asks the signer to sign the event, base64-encodes the compact signed
  event JSON, sends Authorization: Nostr <base64> and Accept:
  application/json, and parses the common envelope.
- Never store a private key, signed event, NIP-46 URI, or bearer header in
  localStorage, sessionStorage, URL parameters, or application state beyond
  the active request.
- Select window.nostr as source nip07 first. Fall back to
  window.colonyOperatorSigner as source nip46. If neither exists, return a
  typed OperatorSignerUnavailable error that the UI renders as a
  connect-operator panel.
- Poll live endpoints every 15 seconds and historical endpoints every 60
  seconds. Abort superseded requests. Keep stale data on screen while a
  refresh is in flight and expose the envelope freshness state.
- Treat 401/403 as an auth state, 503 with live.unavailable as a partial source
  state, and other failures as retryable errors. Do not display raw server
  error bodies.

**Steps:**

- [ ] Add Window.nostr and Window.colonyOperatorSigner declarations in
  window.d.ts using the locked OperatorSigner interface.
- [ ] Write Vitest tests first with an injected fake signer and fake fetch:
  assert kind 27235, exact method/URL/nonce tags, compact event base64, header
  format, no body payload tag on GET, a new signature per request, and no
  storage writes.
- [ ] Implement signer selection, NIP-98 request construction, typed failure
  mapping, and the polling/abort hook.
- [ ] Add a minimal Vite test configuration only when required by the existing
  Vitest setup; do not add a crypto dependency because signing is delegated to
  NIP-07/NIP-46.
- [ ] Run:
  pnpm --dir admin-web test -- operatorAuth,
  pnpm --dir admin-web typecheck, and pnpm --dir admin-web lint.
  Expected result: signer tests, TypeScript, and Biome pass.

**Gate 7:** The browser can authenticate only through an external signer; the
request is bound to the exact URL and method; no key material is persisted.

## Task 8: Build the approved Command Center and drill-down surfaces

**Files:**

- Create: admin-web/src/analytics/AnalyticsLayout.tsx
- Create: admin-web/src/analytics/OverviewPage.tsx
- Create: admin-web/src/analytics/CommunitiesPage.tsx
- Create: admin-web/src/analytics/PeoplePage.tsx
- Create: admin-web/src/analytics/PersonDetailPage.tsx
- Create: admin-web/src/analytics/ActivityPage.tsx
- Create: admin-web/src/analytics/SessionsPage.tsx
- Create: admin-web/src/analytics/DefinitionsPage.tsx
- Create: admin-web/src/analytics/components.tsx
- Create: admin-web/src/analytics.css
- Modify: admin-web/src/App.tsx
- Modify: admin-web/src/main.tsx

**Routes and layout:**

- /analytics: Overview command center.
- /analytics/communities: fleet table and community scope links.
- /analytics/people: bounded searchable directory.
- /analytics/people/:pubkey: metadata-only person detail.
- /analytics/activity: daily activity chart and family/type breakdown.
- /analytics/sessions: live authenticated session table.
- /analytics/definitions: metric and privacy definitions drawer/page.
- Preserve /reports, /reports/:id, /feedback, and /feedback/:id unchanged
  except for the shared navigation shell.

**UI contract:**

- The shell has the approved Command Center hierarchy: global scope selector,
  UTC range selector (24h, 7d, 30d, All time), as-of timestamp, and separate
  historical/live freshness badges.
- Overview cards show unique people, memberships, online people,
  authenticated sessions, open connections, DAU, WAU, and MAU.
- The main body shows daily engagement/activity trend, community health table,
  and a live pulse that visually separates people, sessions, and connections.
- Communities rows drill into the same scope/range query in People and
  Activity.
- People search accepts display name, NIP-05, or full/partial pubkey and shows
  human/agent/unknown, membership count, channel count, owned agents, first
  seen, last activity, and online/session state.
- Person detail has Profile, Memberships and context, Activity, and Sessions
  panels. It never renders an event ID, event content, tags, provider, model,
  private key, raw IP, reverse-DNS label, or geolocation.
- Activity charts offer daily counts, unique people, family breakdown, and
  human/agent/unknown slices. Every chart has a Definitions link.
- Sessions shows one row per connection lease and a summary strip that makes
  one person with two connections visibly different from two people with one
  connection each.
- Empty, stale, unavailable, forbidden, and retry states are explicit. A
  stale response remains visible with its watermark; a Redis-unavailable live
  card says unavailable rather than zero.
- The approved visual tokens and spacing live in analytics.css; do not embed
  an unrelated generic dashboard style in App.tsx.

**Steps:**

- [ ] Add the analytics shell and route matching without breaking the current
  report/feedback deep links.
- [ ] Implement reusable MetricCard, FreshnessBadge, ScopeControls,
  DataTable, EmptyState, UnavailableState, and DefinitionsLink components.
  Keep all visible metric labels tied to the definitions names.
- [ ] Implement the seven pages with the polling hooks and URL-persisted
  scope/range/filter state. Use opaque cursors from the API and do not
  synthesize totals in the browser.
- [ ] Add the signer gate around analytics routes only. Existing reports and
  feedback keep their current authorization path.
- [ ] Add CSS for the approved command-center hierarchy, responsive table
  overflow, readable focus states, and reduced-motion-safe chart transitions.
- [ ] Run:
  pnpm --dir admin-web build and pnpm --dir admin-web check.
  Expected result: production TypeScript/Vite build, Biome, typecheck, and
  existing unit tests pass.

**Gate 8:** The full overview -> community -> people -> person -> sessions
journey is navigable in the existing admin package, with no content leakage
and visible freshness/error states.

## Task 9: Add browser fixtures, relay integration proof, and operational backfill

**Files:**

- Create: admin-web/tests/analytics.spec.ts
- Create: crates/buzz-test-client/tests/e2e_operator_analytics.rs
- Modify: crates/buzz-admin/src/main.rs
- Modify: docs/admin/README.md
- Modify: .env.example
- Modify: docs/admin/operator-analytics.md

**Browser fixture contract:**

- Mock each /operator/analytics/* endpoint with the real envelope shape and a
  deterministic v1 fixture. Add a test-only NIP-07 signer stub that records
  the signed URL/method and returns a structurally valid signed event; API
  routes remain Playwright mocks, so tests do not depend on a live relay.
- Cover overview cards; stale historical badge; Redis-unavailable live pulse;
  community scope drill-down; people search and person detail; two sessions
  for one pubkey; empty communities; forbidden/no-signer states; and a DOM
  assertion that forbidden field names/content do not render.
- Add waitForAnimations before screenshots and capture subject-scoped states.
  Hash screenshots when more than one visual state is posted so identical
  captures cannot pass as distinct proof.

**Rust integration proof:**

- The new e2e_operator_analytics.rs uses the existing test-client NIP-98
  signing helpers and an isolated Postgres/Redis namespace. It creates two
  communities with one shared pubkey, one human, one agent, and one unknown
  event author; inserts qualifying and excluded events; opens sessions on two
  store handles; and queries every API route.
- Assert exact success/failure status for allowlisted, unallowlisted, wrong
  URL, stale, and replayed requests. Assert unique people versus memberships,
  DAU/WAU/MAU exclusions, active-session cards, access-log digests, and
  no-content serialization.
- Assert a Redis outage returns historical data with
  freshness.live.status = "unavailable", and a delayed rollup returns a stale
  historical watermark.

**Backfill command:**

- Add buzz-admin operator-analytics backfill with --community <uuid>
  repeatable, --all as the explicit deployment-wide choice,
  --from <YYYY-MM-DD>, --to <YYYY-MM-DD>, and --batch-size bounded to
  100..5000.
- The command uses the same Db::operator_rebuild_activity transaction and
  classifier as the runtime worker, prints source watermark and row counts,
  and exits nonzero on any community failure. It never prints event content.
- Document the command as the controlled production backfill path. The runtime
  worker remains responsible for new events after the backfill.

**Deployment configuration documentation:**

- Document RELAY_OPERATOR_API_ORIGIN, RELAY_OPERATOR_PUBKEYS,
  POD_NAME/HOSTNAME, same-origin admin serving or a narrowly scoped reverse
  proxy, Redis requirements, migration 0057, and the no-wide-open-CORS rule.
- Document the first-run order: migrate, run backfill, start relay workers,
  serve the admin bundle from the configured origin, connect an allowlisted
  signer, and verify the Definitions page before relying on counts.
- Add a clear PostHog note: it is not installed or queried by this portal.

**Steps:**

- [ ] Add the Playwright routes and signer fixture. Run
  pnpm --dir admin-web test:e2e.
  Expected result: existing report/feedback routes and all analytics states
  pass against mocked envelopes.
- [ ] Add the isolated Rust flow and run:
  . ./bin/activate-hermit && cargo test -p buzz-test-client --test e2e_operator_analytics -- --ignored
  with Postgres and Redis configured.
  Expected result: the complete signed API flow passes without touching a
  developer's live database.
- [ ] Add the CLI backfill command and run:
  . ./bin/activate-hermit && cargo test -p buzz-admin
  and . ./bin/activate-hermit && cargo run -p buzz-admin -- operator-analytics --help.
  Expected result: help lists the bounded backfill options and CLI tests pass.
- [ ] Update the docs and configuration example, then run git diff --check.
  Expected result: no whitespace errors and no undocumented required env var.

**Gate 9:** Mocked browser proof and isolated signed API proof cover the same
response contract. Backfill and runtime rollup share one classifier and one
idempotency path; operators can reproduce the setup without PostHog.

## Task 10: Run the release gates and record evidence

**Files:**

- No new product files. Update the plan checklist and the implementation
  changeset with captured command output, commit SHA, and environment notes.

**Focused gates:**

- [ ] Activate the repository toolchain in every shell:
  . ./bin/activate-hermit.
- [ ] Run Rust formatting and focused tests:
  cargo fmt --all -- --check,
  cargo test -p buzz-db operator_analytics --lib,
  cargo test -p buzz-pubsub operator_sessions --lib,
  cargo test -p buzz-relay operator_analytics --lib,
  cargo test -p buzz-admin.
  Expected result: all non-infrastructure tests pass.
- [ ] Run the admin web gate:
  pnpm --dir admin-web check,
  pnpm --dir admin-web build,
  pnpm --dir admin-web test:e2e.
  Expected result: Biome, TypeScript, Vitest, Vite build, and Playwright pass.
- [ ] With isolated Postgres and Redis available, run the ignored database,
  pubsub, relay, and test-client integration commands from Tasks 3, 4, 6,
  and 9. Capture database and Redis URLs as redacted environment labels, not
  credentials.
- [ ] Run the repository broad gate appropriate to the changed surfaces:
  . ./bin/activate-hermit && just ci.
  If infrastructure or resource limits interrupt the broad gate, stop the
  expensive command, record the exact interrupted command, and leave broad
  acceptance explicitly unproven. Do not report a loud skip as coverage.
- [ ] Run a live isolated deployment walkthrough: start the relay with only
  the test operator pubkey in RELAY_OPERATOR_PUBKEYS; open /analytics with a
  real NIP-07 or NIP-46 signer; verify Overview, Communities, People, Person,
  Activity, Sessions, and Definitions; stop one relay pod and observe lease
  expiry; stop Redis and observe live-unavailable badges; restart Redis and
  confirm live values recover; inspect operator_access_log for digests only.
- [ ] Record implementation, focused-test, committed, merged, deployed, and
  live-proven states separately in the handoff. Include screenshots only from
  the isolated deployment and include the exact migration/rollup watermark
  used by the screenshot.

**Final acceptance gate:**

The feature is ready to merge only when all of these are evidenced:

1. Allowlisted Nostr operator access succeeds without browser private-key
   persistence.
2. Unallowlisted key, stale signature, wrong URL, malformed signature, and
   replay fail closed.
3. Shared pubkeys count once as people and once per active membership.
4. Presence, typing, auth, and transport heartbeats do not enter DAU/WAU/MAU.
5. Multiple sessions for one person remain distinct in session/connection
   counts while online people deduplicate.
6. Agent, channel, thread, membership, and coarse network metadata come from
   authoritative sources; provider/model fields are absent.
7. Daily rollups support all-time history and deterministic rebuilds.
8. Rollup lag and Redis failure are visible per source.
9. No response or browser DOM contains event content, secrets, or full IPs.
10. The complete browser journey is proven against an isolated deployment.

Commit the implementation with git commit -s, keep the plan/spec links in the
PR description, and do not claim merged, deployed, or live-proven until the
corresponding evidence exists.
