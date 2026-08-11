# Colony deployment-wide operator analytics portal design

Date: 2026-08-09  
Status: Design approved in brainstorming; pending written-spec review

## Outcome

Colony gets a private, deployment-wide, read-only operator portal for
answering three different questions without conflating them:

1. How many people and community memberships exist?
2. How much meaningful product activity is happening over time?
3. Who is connected right now, and how many sessions and connections does that
   represent?

The portal is first-party operational infrastructure. It reads deployment
truth from the relay, Postgres, and shared Redis through an authenticated
operator API. PostHog is not the source of truth for this surface and is not a
v1 dependency.

## Product boundary

- V1 is read-only monitoring. It does not suspend users, archive communities,
  change membership, or mutate relay state.
- V1 exposes profile and activity metadata, not message or event content.
- V1 is deployment-wide and can filter by community, but it is not a tenant
  self-service dashboard.
- V1 shows agents, memberships, channels, threads, and session diagnostics only
  where the relay already has authoritative data.
- Provider and model fields are omitted until Colony has a deployment-wide
  authoritative record for them. Client-local runtime configuration is not
  treated as deployment analytics.
- V1 does not add exports. A later export surface would need a separate privacy
  and authorization decision.

## Decisions

| Area | Decision |
| --- | --- |
| First screen | Command center: deployment metrics and live pulse first |
| Headline people metric | Distinct pubkeys across the deployment |
| Secondary population metric | Active community memberships |
| Growth language | “First seen” and “New memberships”; do not call the current user row a signup |
| Engagement | Meaningful accepted activity for DAU/WAU/MAU |
| Live reach | Online people, authenticated sessions, and raw WebSocket connections shown separately |
| Operator identity | NIP-98 request signing by a pubkey in `RELAY_OPERATOR_PUBKEYS` |
| Network detail | Coarse network only; no full remote address in v1 |
| History | Append-only daily rollups retained indefinitely with an All-time view |
| Product analytics vendor | Optional future PostHog layer; never operational truth |

## Existing seams this design reuses

The implementation extends existing code rather than creating a parallel
identity or metrics system:

- `admin-web` is the existing React/Vite private admin package.
- `crates/buzz-relay/src/api/operator.rs` already has deployment-level NIP-98
  authorization, replay protection, and the `RELAY_OPERATOR_PUBKEYS`
  allowlist. Analytics routes reuse this authority.
- `crates/buzz-relay/src/api/admin/mod.rs` currently exposes private,
  host/origin-gated reports and feedback routes under `/api/admin/v1`. Those
  routes remain unchanged; analytics must not silently fall back to their
  host-only authorization.
- `crates/buzz-db/src/usage.rs` already provides exact per-community counts
  and event-derived active-user/channel aggregates. Those queries are suitable
  for backfill and current totals, while the new daily read model prevents
  recurring historical partition scans.
- `crates/buzz-relay/src/state.rs` and the connection lifecycle already know
  live authenticated connections, connection IDs, and remote socket addresses.
  V1 adds a shared server-owned lease so these values are deployment-wide.
- `schema/schema.sql` already models users, relay memberships, channels,
  channel memberships, events, and thread metadata.

## Metric contract

The UI must use these names and definitions consistently. Every metric panel
also shows its UTC window, source, and freshness state through the definitions
drawer.

| Metric | Definition | Default scope |
| --- | --- | --- |
| Unique people | Distinct pubkeys across selected communities; deployment headline is distinct across all communities | Non-deactivated identities by default |
| Community memberships | Active `relay_members` rows | One count per person-community membership |
| First-seen people | Identities whose deployment-wide minimum durable `users.created_at` falls in the window | Not presented as a product signup |
| New memberships | Membership rows created in the window | Community admission/growth |
| Online people | Distinct pubkeys with a fresh server-owned session lease | Deployment-wide, deduplicated across pods and connections |
| Authenticated sessions | Fresh authenticated connection/session leases | One per authenticated WebSocket connection in v1 |
| Open connections | Raw live WebSocket connections | Infrastructure load; multiple per person are allowed |
| DAU/WAU/MAU | Distinct people with at least one qualifying meaningful activity in the UTC window | Engagement, not presence |
| Activity volume | Accepted events grouped into stable activity families | Selected communities and windows |
| Active channels | Distinct channels with qualifying activity in the window | Community or deployment |
| Threads | Thread metadata counts and participation summaries | Metadata only; no content |

### “First seen” is not “signup”

The current `users` row is materialized when a durable profile, command, or
other path first ensures the user in a community. The deployment-wide metric
uses the minimum `users.created_at` across all communities for that pubkey, so
joining another community does not look like a new person. This proves the
relay first encountered an identity; it does not prove that a person completed
a product signup flow.
The portal therefore shows “First seen” and “New memberships”. A future
explicit signup/admission event can add a separate metric without renaming
historical data.

### Meaningful activity

DAU/WAU/MAU use a versioned activity-family allowlist. Initial qualifying
families are accepted product actions represented by durable events, such as
messages, thread activity, channel activity, commands, workflow activity, and
git activity where the existing event taxonomy makes those distinctions.

The following do not qualify on their own:

- presence and away/offline updates;
- typing and transport heartbeats;
- authentication challenges and connection maintenance;
- profile-only refreshes and other metadata synchronization noise.

The definitions endpoint publishes the exact family-to-kind mapping and its
version. Changing the mapping creates a new definitions version rather than
silently rewriting prior DAU/WAU/MAU values.

### Human, agent, and unknown

The existing `users.agent_owner_pubkey` relationship is the authoritative
agent discriminator for the portal. People and activity panels may split
human, agent, and unknown when the join is unavailable. Unknown is a data
quality signal, not silently counted as human.

## Information architecture

The portal uses a left navigation with five primary surfaces:

1. **Overview** — the command center and deployment-wide trend view.
2. **Communities** — a sortable fleet table and community drill-down.
3. **People** — searchable directory and person detail.
4. **Activity** — time series and activity-family breakdowns.
5. **Sessions** — current authenticated sessions and connections.

A global scope selector supports all communities, one community, or a saved
filter. Archived communities are excluded from the default active view but can
be included explicitly.

### Overview

The overview header contains the scope, UTC date range (`24h`, `7d`, `30d`,
`All time`), `as of` timestamp, and per-source freshness indicators.

The first row contains:

- unique people;
- memberships;
- online people;
- authenticated sessions;
- open connections;
- DAU, WAU, and MAU.

The main body contains a daily engagement/activity trend, a community health
table, and a live pulse comparing people, sessions, and connections. The live
pulse refreshes frequently; historical panels refresh less often and retain
their own watermark.

### Communities

The deployment fleet table includes community name/host, status, created date,
people, memberships, channels, threads, online people, DAU/WAU/MAU, activity
volume, and last activity. Every row drills into the same filters in the
activity and people views.

### People

The directory supports bounded search by display name, NIP-05, or pubkey and
filters by community, human/agent classification, online state, and recent
activity. Rows show:

- profile label and shortened pubkey;
- human/agent/unknown type;
- community count and membership status;
- channel count when the existing membership query can produce it;
- agents owned when the existing owner relationship can produce it;
- first seen and last meaningful activity;
- current online/session state.

### Person detail

Person detail is metadata-only and is divided into four panels:

- **Profile:** display name, NIP-05, avatar, pubkey, agent type/owner, and
  deactivation state.
- **Memberships and context:** communities, relay role, channels, and thread
  participation/counts from existing tables.
- **Activity:** first seen, last activity, DAU/WAU/MAU participation, activity
  families, event counts, and trend metadata.
- **Sessions:** current sessions, connection count, started/last-seen time,
  pod, and coarse network detail. Client labels appear only when already
  supplied by an authoritative relay-side handshake field.

Message/event content, private keys, provider credentials, and client-local
provider/model settings never appear here.

### Activity

Activity supports daily trends and breakdowns by community, activity family,
human/agent/unknown type, and selected person. It reports counts and unique
people, not payloads. The definitions drawer is always available from a chart
or table.

### Sessions

Sessions is a live operational view. It shows one row per authenticated
connection lease with person, community, connection/session ID, start time,
last heartbeat, pod, and coarse network. It distinguishes:

- one online person with many connections;
- authenticated sessions that are fresh;
- raw connection count as infrastructure load.

If the shared Redis source is unavailable or stale, the surface says so and
does not replace deployment-wide counts with a single pod’s local estimate.

## Operator API

### Namespace and authorization

Add read-only routes under `/operator/analytics` alongside the existing
deployment operator routes. They reuse:

- `RELAY_OPERATOR_API_ORIGIN` as the canonical signed origin;
- `RELAY_OPERATOR_PUBKEYS` as the deployment operator allowlist;
- request-bound NIP-98 signing with method, exact URL, and body hash when
  applicable;
- the existing replay guard and fail-closed behavior.

The admin web client uses a signer interface. NIP-07 is the first browser
integration; NIP-46/remote signing is a supported fallback. The web client
never receives or persists an operator private key. If the static admin host
and operator API origin differ, use a narrowly configured same-origin proxy or
explicitly scoped origin; do not add broad CORS or a host-only fallback.

### Routes

All routes are `GET`, reject unknown filters, cap page sizes, and use cursor
pagination where a list can grow:

```text
GET /operator/analytics/overview
GET /operator/analytics/communities
GET /operator/analytics/people
GET /operator/analytics/people/{pubkey}
GET /operator/analytics/activity
GET /operator/analytics/sessions?status=active
GET /operator/analytics/definitions
```

Supported filters include community, UTC start/end, activity family,
human/agent/unknown type, online state, and bounded search. The API returns a
stable envelope:

```json
{
  "data": {},
  "as_of": "2026-08-09T12:00:00Z",
  "freshness": {
    "historical": {"status": "fresh", "watermark": "2026-08-09T11:59:00Z"},
    "live": {"status": "fresh", "observed_at": "2026-08-09T12:00:00Z"}
  },
  "definitions_version": "v1"
}
```

Partial source failures are represented in `freshness` and warnings; the
server does not merge values from incompatible timestamps without saying so.

## Data model and aggregation

### Daily activity read model

Add an idempotent derived table with one row per UTC day, community, person,
and activity family:

```text
operator_activity_daily
  utc_day             DATE
  community_id        UUID
  pubkey              BYTEA
  activity_family     TEXT
  event_count         BIGINT
  first_activity_at   TIMESTAMPTZ
  last_activity_at    TIMESTAMPTZ
  PRIMARY KEY (utc_day, community_id, pubkey, activity_family)
```

Add indexes for `(utc_day, community_id)`, `(community_id, pubkey, utc_day)`,
and the deployment-wide distinct-person query pattern. The table is derived
and rebuildable; source events remain authoritative.

New accepted events advance an idempotent watermark or queue-backed rollup
worker. A backfill uses existing exact event queries and writes the same
idempotent rows. Rollup lag is visible through the API freshness envelope.

Deployment-wide unique people are calculated with `COUNT(DISTINCT pubkey)`
across the selected community rows. Community memberships remain a separate
count and are never substituted for people.

### Live session leases

After successful NIP-42 authentication, each WebSocket connection receives a
server-owned lease in shared Redis. The lease stores only operational metadata:

- connection/session ID;
- community and authenticated pubkey;
- pod ID;
- started and last-seen timestamps;
- coarse network block;
- optional existing client label.

The lease refreshes with the server lifecycle/heartbeat and expires after the
existing presence-scale TTL (90 seconds). Cleanup can mark a connection ended,
but TTL expiry remains the crash-safe authority. The API counts fresh leases
across all pods, counts connection/session IDs directly, and deduplicates
online pubkeys.

Raw network details are not written to the daily analytics model. V1 derives a
coarse IPv4 network (for example `/24`) or IPv6 network (for example `/64`),
with pod/region only when the deployment already has that field. No reverse
DNS, geolocation, or full IP display is added.

### Channels, threads, agents, and providers

- Agent count uses `users.agent_owner_pubkey` and existing owner relationships.
- Channel totals and memberships use `channels` and `channel_members`.
- Thread counts and reply/descendant summaries use `thread_metadata` and event
  joins that already exist for thread rendering.
- Provider/model settings are excluded because current authoritative values are
  client/runtime configuration, not a deployment-wide relay record.

## Privacy and operator accountability

- The portal is read-only but still requires individual operator identity.
- Every request is NIP-98 signed by an allowlisted pubkey; replay, wrong URL,
  stale timestamp, malformed signature, and unallowlisted pubkey are rejected.
- Append a deployment-global operator access record with operator pubkey,
  route, filter/target digest, outcome, request ID, and timestamp. Do not put
  signed payloads, raw query values, message content, or secrets in logs.
- The existing per-community hash-chain audit log is not repurposed as a
  deployment-global access log; the two scopes have different authority
  semantics.
- Responses use an explicit field allowlist and no event content. Error
  messages do not echo private query material.
- Coarse network blocks are visible in active session diagnostics only.
- The definitions page explains source, exclusions, UTC semantics, identity
  deduplication, and freshness so operators do not mistake a metric for a
  stronger claim than the data supports.

## Failure and freshness behavior

| Failure | Portal behavior |
| --- | --- |
| Rollup worker lag | Historical cards show watermark and lagging badge; no silent “current” claim |
| Redis unavailable | Live sessions/online cards show unavailable; historical panels continue if fresh |
| One pod disappears | Its leases expire; remaining pods continue; the UI shows the observation time |
| Unknown user classification | Show unknown slice/data-quality warning instead of human inference |
| Empty community or period | Render explicit zero/empty state with definition link |
| Operator auth failure | Return 401/403 without revealing whether a target exists |
| Partial endpoint source failure | Preserve successful panels and show per-panel warning |

## PostHog decision

PostHog is not included in v1. It can be considered later for product-behavior
questions that the operational read model is not designed to answer, such as
feature funnels, path analysis, retention cohorts, or UI experiment analysis.
If added, it must be a separate, privacy-reviewed event stream with stable
pseudonymous identity, opt-out/consent behavior where required, and an explicit
statement that PostHog cannot define deployment people, memberships, or live
sessions.

## Implementation phases and proof gates

### Phase 1: contracts and authority

- Add typed response models, definitions version, field allowlist, operator
  access-log contract, and NIP-98 analytics route authorization.
- Prove allowlist, exact URL binding, replay rejection, timestamp bounds, and
  no host-only analytics fallback.

### Phase 2: read models and live state

- Add the daily activity table, indexes, idempotent watermark/backfill, and
  freshness reporting.
- Add server-owned Redis session leases and deployment-wide aggregation.
- Prove multi-community distinct-person counts, membership counts, activity
  exclusions, multi-pod deduplication, and TTL crash recovery.

### Phase 3: operator UI

- Build the Command center in the existing `admin-web` package.
- Add Communities, People, Activity, Sessions, and Definitions surfaces.
- Add signer integration without private-key persistence.
- Prove the overview → community → people → person → session path in an
  isolated deployment with visible stale/empty/error states.

### Phase 4: operational hardening

- Backfill a representative historical deployment and verify counts against
  exact source queries.
- Load-test all-time overview and people search with bounded pagination.
- Test Redis degradation, pod loss, rollup lag, auth failures, and cross-
  community filters.
- Report implemented, locally tested, committed, merged, deployed, and live-
  proven states separately.

## Out of scope for v1

- Raw event or message content inspection.
- User suspension, community archive, membership changes, or any mutation.
- CSV/JSON exports.
- Full raw IP addresses, geolocation, reverse DNS, or client fingerprinting.
- Provider/model analytics sourced from client-local configuration.
- PostHog as the operational source of truth.
- Long-lived per-connection history beyond the live lease and daily activity
  metadata required by the portal.

## Success criteria

1. An allowlisted Nostr operator can authenticate without putting a private key
   in the browser and can load the deployment overview.
2. An unallowlisted key, stale signature, wrong signed URL, and replay are
   rejected fail-closed.
3. A pubkey present in several communities counts once as a person and once
   per membership as membership rows.
4. Presence, typing, authentication, and heartbeat noise do not inflate
   DAU/WAU/MAU.
5. One person with multiple connections counts once online and once per active
   session/connection in the appropriate cards.
6. The portal shows agents, channels, threads, memberships, and coarse network
   details from authoritative existing data, and omits provider/model fields
   when no deployment source exists.
7. Daily rollups support indefinite All-time history and are idempotently
   rebuildable.
8. Stale or unavailable sources are visible per panel rather than silently
   replaced with incompatible pod-local values.
9. Person and activity responses contain no message/event content, secrets, or
   full remote addresses.
10. The complete browser workflow is proven against an isolated deployment.
