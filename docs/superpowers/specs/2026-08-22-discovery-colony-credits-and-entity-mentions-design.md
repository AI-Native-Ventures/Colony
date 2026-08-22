# Discovery Colony Credits and Entity Mentions Design

**Date:** 2026-08-22
**Status:** Ready for product review
**Branch:** `feat/discovery-colony-credits`

## Goal

Make Business Discovery a Colony-funded, agent-operable product instead of a
bring-your-own-provider workflow.

The launch must:

1. remove user-supplied Discovery provider keys and source controls;
2. charge a fixed 5 cents of Colony Credits for each new retained Lead;
3. let a human approve one maximum Colony Credits budget per Campaign;
4. let agents start and retry runs within that approved budget;
5. keep the mature worker on the user's desktop for the first release;
6. return light public business profiles only;
7. make Industries, Verticals, Campaigns, Campaign Lead collections,
   individual Leads, and Discovery runs searchable and mentionable in every
   message composer; and
8. resolve every mentioned Discovery entity into current, permission-checked
   agent context.

## Approved product decisions

- Colony owns the Outscraper, Brave Search, and Exa Search accounts and keys.
- Colony chooses the source mix. Users buy a result, not a vendor configuration.
- The first release keeps execution in the desktop worker. Runs pause when the
  desktop closes and resume through the existing lease and checkpoint protocol.
- The customer price is fixed at 50,000,000 nanoUSD, equal to 5 cents, for each
  new retained and deduplicated Lead.
- Failed provider requests, empty results, and duplicates are not charged to the
  customer.
- Provider cost remains an internal margin measure and does not drive the
  customer debit.
- A human approves one maximum Campaign budget. Agents may start, retry, pause,
  resume, and inspect runs while that approval remains valid and budget remains.
- Creating, reading, searching, and mentioning Discovery records is free.
- An always-on Colony worker is a later phase. This design preserves a clean
  migration path without building it now.

## Approaches considered

### 1. Approved: hosted provider gateway with the existing local worker

The desktop worker keeps its lease, retry, cancellation, normalization, and
durable outbox responsibilities. It no longer reads provider keys or calls
provider hosts directly. Instead, it sends bounded provider operations to an
authenticated Colony gateway. The gateway validates the active Discovery
lease, uses server-held keys, and returns only the provider data required by
the existing normalizers.

This is the fastest safe launch. It removes customer credentials and enables
Colony Credits without duplicating the mature worker. Its explicit limitation
is that a run cannot progress while the desktop is offline.

### 2. Always-on worker inside the relay

Moving the provider executors into the relay would let runs continue while the
desktop is offline. Provider spend is the same, but server compute, network,
secret operations, capacity planning, and worker isolation become Colony's
responsibility. It also requires a larger worker authorization and deployment
change. This is deferred until real usage shows that offline execution is worth
that operating cost.

### 3. Generic provider proxy

A relay endpoint that forwards arbitrary URLs, headers, or provider bodies
would be quick but unsafe. It could expose Colony credentials, become an open
proxy, bypass Campaign budgets, and make provider cost impossible to attribute.
It is rejected.

## Customer journey

### Human-created Campaign

1. The user chooses an Industry, Vertical, location, Lead target, and optional
   ideal-customer description.
2. Colony shows the fixed 5 cent price, the maximum Campaign cost, and the
   current Colony Credits balance.
3. The user creates the Campaign and approves its maximum budget in the same
   signed action.
4. The relay stores the Campaign fingerprint, payer, approved maximum, and
   approval evidence.
5. The user or an agent starts Discovery while the desktop is online.
6. The relay reserves the maximum billable amount for that run before any
   provider request is allowed.
7. The worker uses the Colony provider gateway and stores normalized results
   through the existing fenced worker protocol.
8. At a terminal boundary, the relay charges only newly retained Leads and
   releases the rest of the reservation.

### Agent-created Campaign

1. The agent may search taxonomy, create a Campaign, and inspect it for free.
2. The Campaign begins with no approved budget.
3. The agent presents the existing signed `approval` Block containing the exact
   Campaign fingerprint, payer, maximum budget, fixed unit price, and expiry.
4. A human approval action is durable evidence. The agent submits its event ID
   with the Campaign budget action.
5. The relay verifies the approval event, author, Block instance, exact content,
   expiry, and one-time use before activating the budget.
6. The agent may then start and retry runs without another approval while the
   approved fingerprint and remaining budget still match.

An agent can never approve its own budget, increase a budget, change a Campaign
fingerprint under an approval, or spend against another human's balance.

## Campaign fingerprint and approval invalidation

The approved fingerprint covers:

- Campaign ID;
- Industry ID;
- Vertical ID;
- query;
- location;
- target;
- language;
- region;
- fixed price per retained Lead; and
- payer pubkey.

Changing any covered field invalidates the approval and releases any unclaimed
Campaign reservation. Changing presentation-only fields such as Campaign name
or description does not require a new approval.

The human can pause or revoke the budget at any time. Revocation prevents new
provider requests. An in-flight provider call may complete, but its result must
still pass the current lease fence before storage and settlement.

## Budget and pricing model

Money remains integer nanoUSD end to end. The launch price is
`50_000_000` nanoUSD per retained Lead.

For each run:

```text
campaign_remaining = approved_budget - spent - reserved
account_available = account_balance - all_active_discovery_reservations
lead_capacity = min(campaign_target_remaining,
                    floor(campaign_remaining / unit_price),
                    floor(account_available / unit_price))
reservation = lead_capacity * unit_price
settlement = newly_retained_unique_leads * unit_price
release = reservation - settlement
```

The relay refuses a run before provider spend when `lead_capacity` is zero.
The run snapshots its unit price and billable Lead limit so a later price
change cannot alter an accepted run.

Price changes are server configuration changes that affect only newly approved
Campaign budgets. Historical Campaign approvals, runs, and ledger rows retain
their exact unit price.

## Atomic reservation and settlement

The reservation authority is the relay database, not the desktop UI or worker.

Admission locks the payer account and Campaign, verifies the current Campaign
fingerprint and approval, sums active reservations for that payer across all
communities, computes capacity, creates the run, and increments the Campaign
reservation in one transaction.

Terminal settlement locks the payer account, Campaign, and run. It derives the
billable quantity from observations inserted as new records for that exact run.
It then:

1. inserts one idempotent `credit_ledger` debit with reference
   `discovery:run:<run-id>`;
2. debits the payer balance;
3. increments Campaign spent;
4. releases the full run reservation;
5. snapshots quantity, unit price, and charged amount on the run; and
6. marks the run settled.

Those writes commit together. A replay selects and returns the existing ledger
entry. It cannot debit again.

A retry is a new run and may charge only Leads newly retained by that retry.
The existing community-wide deduplication boundary means a business already
stored by an earlier run is a duplicate and is not charged again.

Cancelled and failed runs settle any new Leads that were durably retained
before the terminal boundary, then release the unused reservation. A run with
no new retained Leads creates no debit.

## Data changes

The design extends existing tables instead of creating a parallel money
system.

`discovery_campaigns` gains:

- budget payer pubkey;
- approved, spent, and reserved nanoUSD amounts;
- approval action event ID and approval timestamp;
- approved Campaign fingerprint;
- budget state: `unapproved`, `active`, `paused`, `revoked`, or `exhausted`.

`discovery_runs` gains:

- hosted-gateway worker protocol version;
- payer pubkey;
- snapshotted unit price;
- billable Lead limit;
- reserved, settled, and released nanoUSD amounts;
- billed retained Lead count;
- settlement reference and timestamp.

`credit_ledger` gains nullable usage attribution fields so Discovery revenue is
not misrepresented as model usage and non-usage credits remain neutral:

- service: `model` or `discovery` for usage debits, otherwise null;
- quantity;
- unit price nanoUSD; and
- Discovery Campaign and run IDs when service is `discovery`.

Existing debits with a model backfill to `service = model`. Seeds, credits, and
corrections remain null. Existing balance and idempotency behavior remains
unchanged.

No new public table or public URL is introduced. All rows remain behind the
relay's authenticated, community-scoped operations.

## Provider gateway

The provider gateway exposes a small allowlist of Discovery operations, not raw
provider HTTP access:

- submit and poll a Google Maps business search through Outscraper;
- execute one bounded Brave Search page;
- execute one bounded Exa Search page; and
- read only the safe provider request state needed for retry recovery.

The relay owns the source plan. The launch default is a waterfall of Google Maps,
Brave Search, then Exa Search, stopping when the billable Lead limit is reached.
An operator-only server configuration may narrow or reorder that allowlist for
new runs. Invalid or unavailable configuration fails startup. Every run stores
its immutable source-plan snapshot so later configuration cannot change work
already admitted.

Every request must include NIP-98 authentication from the active human desktop
identity plus the run ID, claim ID, source key, and deterministic request
fingerprint. The relay verifies:

- the actor is a current human member with Discovery access;
- the run belongs to the same community and payer;
- the claim and lease are current;
- the source is in the relay-owned plan;
- the Campaign budget is active;
- the run still has reserved billable capacity;
- the request is within provider-specific bounds; and
- the same fingerprint replays the same provider request instead of spending
  twice.

The gateway constructs provider URLs and headers itself. It never accepts a
provider hostname, authorization header, or arbitrary body from the client.
Search parameters and page cursors are derived from the immutable run and its
durable source checkpoint, not trusted from the client. Provider responses are
filtered to the light-profile allowlist before they return to the desktop.
Provider keys stay in relay environment secrets and never enter logs, events,
receipts, desktop IPC, or database rows.

Provider errors are mapped to existing safe failure classes. Raw provider
bodies and credential errors never reach chat or the user interface.

## Worker protocol and rolling release

Hosted-gateway runs use a new worker protocol version. Old desktop workers
cannot claim them or call the provider gateway.

Release order:

1. deploy the relay with the new schema, price configuration, gateway routes,
   and protocol support disabled for customer runs;
2. publish the desktop with the hosted-gateway worker protocol and new UI;
3. enable hosted-gateway Campaign adoption after the supported desktop version
   is available; and
4. prove one real paid run before removing the old direct-provider path from
   the release branch.

Once a Campaign adopts hosted-gateway mode, source updates from older clients
are rejected and direct-provider workers cannot claim its runs. Existing old
runs may finish under their original protocol, but no old run can consume a new
Campaign budget.

## Removing user provider controls

The desktop removes:

- Discovery provider key fields from Settings;
- source selection from Campaign creation;
- source ordering, enable switches, and concurrent or waterfall controls from
  Campaign detail;
- credential checks before run start; and
- agent command flags for provider source selection.

The desktop continues to show provider names and freshness in completed run and
Lead provenance.

Previously stored Discovery provider keys become dormant as soon as the new
worker protocol is active. The release removes the known Discovery keychain
entries once, after successful hosted-mode adoption. It does not touch model,
relay, or other application credentials. The removal is recorded locally
without logging secret values.

## Light profile contract

Discovery may store only public fields already returned by an approved source:

- business name;
- website and canonical domain;
- public phone and email when supplied by the source;
- public address, locality, country, and coordinates;
- category and public subtypes;
- business status;
- public contact name and title when directly supplied;
- public source URL;
- short public source snippet or description;
- fit score and deterministic reasons derived from Campaign criteria;
- provider provenance; and
- observed freshness timestamp.

The provider gateway and worker must not request deep enrichment, personal
profiles, inferred private contact data, paid email discovery, or LLM-generated
company research. There is no deep-enrichment stage, action, button, or hidden
background call. An agent may later research a mentioned Lead using its normal
tools and permissions, with separate Colony Credits metering where applicable.

## Universal Discovery mentions

Every message composer uses one ranked directory containing people, agents,
teams, Blocks, and the following Discovery entities:

- Industry;
- Vertical;
- Campaign;
- Campaign Lead collection;
- Lead; and
- Discovery run.

Discovery suggestions are fetched only for the active community. Search is
debounced, bounded, and paginated. It does not preload every Lead into the
desktop.

Selecting a Discovery suggestion inserts readable `@Label` text and a signed
structured tag:

```text
["discovery", "<kind>", "<stable-id>", "<label>"]
```

The label is presentation only. The stable kind and ID are authoritative.
Discovery mentions do not notify an entity and do not add a person recipient.
Draft persistence stores the same structured reference so reopening a draft
does not turn it into ambiguous plain text.

A Campaign Lead collection is a bounded virtual reference for the Leads in one
Campaign, optionally with one existing funnel status. It is not a copy of every
Lead and does not create a new saved-view table in this release.

## Permission-checked agent context

Message events store only structured references, never a Lead profile snapshot.
Before an event enters an agent prompt, the agent processor resolves each
Discovery tag through the current workspace read contract using the receiving
agent's identity.

The resolver:

- verifies the referenced community equals the event channel community;
- verifies current Discovery membership and capability;
- ignores forged, malformed, duplicate, or unauthorized references;
- resolves at most 20 Discovery references per message;
- returns bounded current projections;
- records unavailable references as unavailable without revealing whether a
  hidden record exists; and
- includes source entity IDs so the agent can call the existing CLI for more.

Context shapes are intentionally bounded:

- Industry and Vertical: taxonomy ID, label, description, and Lead or Campaign
  counts;
- Campaign: targeting fields, budget state and remaining amount, Lead count,
  latest run summary, and provenance summary;
- Campaign Lead collection: filter, total count, and at most 25 summary rows;
- Lead: the current full permission-checked Lead projection;
- run: status, source progress, retained and duplicate counts, charge summary,
  and safe failure reason.

The displayed message label remains stable while the hydrated context is always
current. Deleting access after a message was sent prevents later hydration.

## Agent command surface

The CLI retains Campaign, Lead, and run reads and gains:

- taxonomy search;
- Industry and Vertical detail;
- Discovery entity search for mention suggestions;
- Campaign budget request and approval-evidence submission;
- Campaign budget status, pause, and revoke;
- Campaign create without provider flags; and
- run start with structured budget-exhausted output.

The source-selection command and source flags are removed from normal help. A
rolling-compatibility parser may accept them temporarily, but hosted Campaigns
ignore them and the relay remains the source-plan authority.

## UI contract

Campaign creation shows:

- Industry and Vertical;
- Campaign name;
- location;
- target Lead count;
- optional ideal-customer description;
- 5 cent price per retained Lead;
- maximum Campaign budget; and
- available Colony Credits.

Campaign detail shows approved, spent, reserved, and remaining budget; estimated
remaining Lead capacity; current run status; provenance; pause or revoke; and a
request-more-budget action when exhausted.

If the desktop closes during a run, the Campaign says it is waiting for this
device and resumes after the worker restarts. It must not imply that Colony is
still processing in the cloud.

## Failure handling

- Insufficient account balance or Campaign budget fails before provider spend.
- A lost lease stops new gateway calls and rejects later result writes.
- A provider call with an unknown outcome preserves its reservation and resumes
  from the deterministic request fingerprint. It is never blindly resubmitted.
- A worker crash after storing Leads but before settlement is recovered by the
  relay settlement transaction from durable observations.
- A settlement replay returns the existing ledger entry.
- Revocation blocks new provider work and releases reservation only after the
  run reaches a fenced terminal state.
- A deleted or unauthorized mentioned entity resolves as unavailable.
- Gateway key absence or invalidity fails closed and never falls back to a user
  credential.

## Security and privacy

- Provider keys are server-side secrets only.
- The gateway is provider-specific and never a generic forward proxy.
- Every paid operation is bound to community, payer, Campaign, run, claim,
  source, request fingerprint, and reservation.
- Client-supplied labels, prices, counts, source plans, provider hosts, and
  authorization headers are never trusted.
- Public business data stays community-scoped and is served only through
  authenticated relay operations.
- Message events contain entity references, not private expanded context.
- Logs contain safe IDs and counts only, never provider headers, raw bodies,
  contact payloads, approval contents, or Colony credentials.

## Excluded from this release

- an always-on Colony Discovery worker;
- People or individual-person discovery;
- deep enrichment or automatic LLM research;
- custom saved Lead views beyond Campaign and one-status virtual collections;
- user-selected providers or source order;
- provider-key synchronization or export;
- changes to normal model gateway pricing; and
- charging for duplicate, failed, empty, or merely returned provider results.

## Acceptance gates

1. A fresh user can create and run Discovery without entering any provider key
   or choosing any source.
2. A supported desktop uses only the Colony provider gateway. Direct provider
   requests and local Discovery credential reads are absent from the production
   path.
3. Starting a run atomically reserves no more than the approved Campaign budget
   and available payer balance.
4. One newly retained Lead produces exactly one 50,000,000 nanoUSD debit.
   Duplicate, failed, empty, replayed, and stale-lease paths produce no extra
   debit.
5. Crash recovery after provider submission, Lead storage, and settlement
   preserves one provider request and one customer charge.
6. An agent cannot approve a budget, forge human approval, change approved
   targeting, or spend above the remaining maximum.
7. Revocation and exhaustion stop new provider work at the next fenced boundary.
8. The desktop clearly says a paused offline run is waiting for the device.
9. Only light public fields enter provider requests, relay rows, desktop UI, and
   agent context.
10. Every requested Discovery entity is searchable with `@`, survives draft
    reload as a stable reference, and hydrates current context only for an
    authorized receiving agent.
11. Lead collection context is bounded and does not copy an unbounded list into
    the message or agent prompt.
12. Provider keys appear zero times in client bundles, IPC responses, events,
    logs, receipts, database rows, and test artifacts.
13. Existing old-protocol runs can finish, while old workers cannot claim or
    spend from hosted-gateway Campaign budgets.
14. Full affected Rust and Desktop package suites, repository checks, production
    builds, real-relay fault tests, and driven desktop browser flows pass on the
    same exact commit.
15. Production proof includes one real approved Campaign run, correct retained
    Lead count, correct credit debit, released reservation, provider provenance,
    and a message whose Discovery mention gives an agent the current entity
    context.
