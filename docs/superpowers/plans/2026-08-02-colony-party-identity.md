# Colony Phase 2 — Stable party and CRM identity

**Design source:** `docs/superpowers/specs/2026-07-31-colony-company-operating-system-design.md`
(§ "Leads, Clients, and stable identity", § "Campaign and acquisition model",
§ "Owned structured cores")

**Roadmap gate:** `docs/superpowers/plans/2026-07-31-colony-company-os-roadmap.md`
§ Phase 2. Phase 1A (company operating kernel) and Phase 1B (Chief of Staff
onboarding) are merged and proven; this is the next unblocked phase.

**Proof gate:** one organization discovered twice resolves to one identity, may
be both Lead and Client at once, and retains one reference handle with complete
provenance.

---

## Why this phase exists

Every later phase writes about external parties. Discovery finds them, Outreach
contacts them, Opportunities value them, Clients bill them, and the Cost Ledger
attributes delivery cost to them. If each of those keeps its own copy, the same
business becomes five records that disagree, and no report about a customer can
be trusted.

Today there is nothing. `desktop/src/features/discovery/` ships a `Lead` type
and a `LeadStatus` enum, and nothing persists them: the feature has no
`invokeTauri`, no relay call, and no storage. That is fine as parity UI, and it
is exactly why identity has to land before Phase 4 grows a system of record
underneath it by accident.

---

## The architectural decision this plan makes

**A canonical Party is a relay-authored NIP-33 head, like Company, Initiative,
and Task. Raw Discovery candidates are not.**

The design lists "canonical Organizations and People" among owned structured
cores, alongside Discovery candidates and Cost Ledger entries. Those two
neighbours are genuinely high-volume: a single Discovery run can return
thousands of candidates, and a busy month produces tens of thousands of ledger
entries. Canonical parties are not that. They are the deduplicated set a
company has actually chosen to engage — hundreds to low thousands for the
businesses Colony serves — and the relay already stores every message those
same companies send.

Making Party a relay-authored head buys the whole of Phase 1A's proven
machinery unchanged: owner-only authorization, compare-and-set on an exact
head, derived idempotency keys, durable receipts, tenant scoping, `#d` and `#c`
queries, realtime fan-out, and a desktop repository shape that already exists
and is tested. Building a second structured core with its own action broker,
its own query surface, and its own authorization would duplicate all of it to
serve a volume that does not need it.

The boundary is therefore:

| Record | Home | Why |
|---|---|---|
| Discovery candidate | structured core (Phase 4) | thousands per run, mostly discarded, never referenced from chat |
| Canonical Party | relay-authored head (this plan) | company-owned, referenced from chat, must survive merges |
| Party relationship (Lead / Client) | relay-authored head (this plan) | one per party per view, owner-governed lifecycle |
| Cost Ledger entry | structured core (Phase 3) | append-only at high volume, never mutated |

**Reviewers should challenge this first.** If Phase 4's parity work shows that
accepted Leads routinely reach five figures per company, the Party head becomes
the wrong home and this plan needs redoing before Task 4. The decision is
recorded here rather than buried in a commit so that it can be reversed cheaply
while it is still only a plan.

---

## Scope guardrails

- No new product page. Parties are referenced from chat and rendered in Blocks
  and the existing Discovery surface; a CRM screen is Phase 4's business.
- No copied records. Lead and Client are views over one identity, never
  duplicated party rows with a `type` column.
- No destructive merge. Merging never deletes evidence and never breaks a
  handle that was already handed out.
- No automatic promotion. A Discovery candidate does not become a Party without
  an explicit decision, matching the design's rule that Discovery results do not
  silently become Leads.
- No new HTTP endpoint. Mutations are owner-signed events; reads are Nostr
  filters with explicit kinds.
- Phase 2 does not deliver Campaigns, Audiences, Outreach, Opportunities, or
  the client-handoff Approval Block. It delivers the identity those stand on.

---

## Required execution order

Tasks 1 → 10 in order. Task 4 (relay broker) cannot be written before Task 3
(SDK envelopes), and Task 8 (handle resolution) cannot be proven before Task 6
(merge) exists to break it.

---

## Acceptance gates

### Gate A — Identity and provenance

- A Party has one stable handle, one canonical record, and a provenance list
  naming every source that contributed to it.
- Two Discovery observations of the same organization resolve to one Party.
- Every field on a Party can be traced to at least one provenance entry.
- A Party with no provenance is refused.

### Gate B — Relationship views

- The same Party can carry a Lead relationship and a Client relationship at
  once, with independent lifecycle state.
- A relationship cannot exist without its Party.
- Deleting or cancelling a relationship leaves the Party and its other
  relationships untouched.

### Gate C — Merge without loss

- Merging two Parties produces one survivor, retires the other's handle, and
  preserves both provenance lists.
- Every handle ever issued still resolves after the merge, transitively through
  chains of merges.
- A merge is refused when it would create a cycle or when either side is
  already retired.
- Relationships on both sides survive onto the survivor without duplication.

---

## Wire contracts

### Kinds

Add to `crates/buzz-core/src/kind.rs`:

```rust
/// Canonical external Organization or Person (relay-authored head).
pub const KIND_PARTY: u32 = 30182;
/// A company's Lead or Client view over one Party (relay-authored head).
pub const KIND_PARTY_RELATIONSHIP: u32 = 30183;
/// Owner-signed request to create or mutate canonical party state.
pub const KIND_PARTY_ACTION: u32 = 40015;
/// Relay-signed auditable result of a party action.
pub const KIND_PARTY_RECEIPT: u32 = 40016;
```

`30182` and `30183` are parameterized-replaceable; assert that in the same
`const _: () = assert!(...)` block the company kinds use.

### Party

`d` = party handle. `c` = company ID. Additional scalar tags: `party-kind`
(`organization` or `person`), and one `identifier` tag per external identifier
so a Discovery run can find an existing Party by domain or email without
scanning.

```json
{
  "schema": "colony.party/v1",
  "id": "acme-industries",
  "companyId": "horizonlabs",
  "kind": "organization",
  "displayName": "Acme Industries",
  "legalName": null,
  "identifiers": [
    { "scheme": "domain", "value": "acme.example", "confidence": "asserted" }
  ],
  "provenance": [
    {
      "id": "prov-01",
      "source": "discovery:google-maps",
      "observedAt": 1785369600,
      "sourceRef": "run-7f3a/result-12",
      "fields": ["displayName", "identifiers"]
    }
  ],
  "retiredHandles": [],
  "createdAt": 1785369600,
  "updatedAt": 1785369600
}
```

**`identifiers` carry a scheme, not a free string.** A domain and an email that
happen to share text are not the same claim, and merge decisions are only
defensible when the thing being compared is typed.

**`provenance` names fields.** "This came from Google Maps" is not enough to
resolve a conflict; "the display name came from Google Maps on this date, and
the legal name came from a document the owner uploaded" is.

### Party alias

When a merge retires a handle, the relay writes a head at the retired
coordinate so the handle keeps resolving:

```json
{
  "schema": "colony.party-alias/v1",
  "id": "acme-inc",
  "companyId": "horizonlabs",
  "resolvesTo": "acme-industries",
  "mergedAt": 1785370000,
  "mergeActionEventId": "…"
}
```

Same kind (`30182`), distinguished by `schema`. Every handle ever issued
therefore resolves at its own coordinate forever, as either a Party or a
pointer to one. No alias index, no scan, and a client that fetches a stale
handle gets a definite answer rather than a miss.

### Party relationship

`d` = `{partyId}:{relationship}`. `c` = company ID. `party` tag = party handle.

```json
{
  "schema": "colony.party-relationship/v1",
  "id": "acme-industries:lead",
  "companyId": "horizonlabs",
  "partyId": "acme-industries",
  "relationship": "lead",
  "status": "qualified",
  "ownerPersonaId": "company-role:abc:horizonlabs:sales-lead",
  "sourceChannelId": "welcome",
  "createdAt": 1785369600,
  "updatedAt": 1785369600
}
```

`relationship` is `lead` or `client`. Lead statuses: `candidate`, `accepted`,
`qualified`, `disqualified`, `dormant`. Client statuses: `active`, `paused`,
`former`. Transitions are `const fn` predicates beside the company ones.

### Party action

Identical envelope to `KIND_COMPANY_ACTION`: `p`, `a`, and a
`party-action` tuple, with operations `create`, `update`, `transition`, and
`merge`. `merge` carries both handles and is the only operation that writes two
heads in one transaction.

---

## Task 1: Pin the kinds and write the red contract tests

**Files:**

- Modify: `crates/buzz-core/src/kind.rs`
- Modify: `desktop/src/shared/constants/kinds.ts`
- Modify: `mobile/lib/shared/relay/nostr_models.dart`
- Modify: `mobile/test/shared/relay/nostr_models_test.dart`
- Create: `crates/buzz-core/src/party.rs`

### Step 1: Pin the numbers

- [ ] Add the four kinds, the parameterized-replaceable assertions, and the
  mirrors in TypeScript and Flutter, exactly as Phase 1A did for `30179`–`30181`.

### Step 2: Write failing contract tests

- [ ] Schema and identifier validation, including a party with no provenance.
- [ ] Every provenance entry names at least one field that exists on the record.
- [ ] Identifier scheme is closed; duplicate `(scheme, value)` pairs are refused.
- [ ] Relationship transition tables, including every refused transition.
- [ ] A relationship whose `partyId` does not match its `id` prefix is refused.
- [ ] Alias records: `resolvesTo` must differ from `id`.

### Step 3: Run red

```bash
. ./bin/activate-hermit
cargo test -p buzz-core party --no-fail-fast
```

### Step 4: Commit the red tests

```bash
git add crates/buzz-core/src/kind.rs crates/buzz-core/src/party.rs \
  desktop/src/shared/constants/kinds.ts \
  mobile/lib/shared/relay/nostr_models.dart \
  mobile/test/shared/relay/nostr_models_test.dart
git commit -s -m "test(core): pin the Colony party identity contract"
```

---

## Task 2: Implement the party contract

**Files:** Modify `crates/buzz-core/src/party.rs`, `crates/buzz-core/src/lib.rs`

### Step 1: Types and validation

- [ ] `Party`, `PartyKind`, `PartyIdentifier`, `IdentifierScheme`,
  `ProvenanceEntry`, `PartyAlias`, `PartyRelationship`, `RelationshipKind`,
  `LeadStatus`, `ClientStatus`, with `deny_unknown_fields` on every struct.
- [ ] `validate_party`, `validate_party_update`, `validate_relationship`,
  `validate_relationship_update`, `validate_alias`, mirroring the company
  validators' shape so the two read alike.
- [ ] `is_lead_status_transition_allowed` / `is_client_status_transition_allowed`
  as `const fn`.
- [ ] `merge_parties(survivor, retired) -> Result<Party, PartyContractError>`:
  unions identifiers and provenance, keeps the survivor's `displayName` unless
  it is empty, appends the retired handle to `retiredHandles`, and refuses when
  either side is already an alias.

### Step 2: Prove green and commit

```bash
cargo test -p buzz-core party --no-fail-fast
cargo fmt --all -- --check && cargo clippy -p buzz-core --all-targets
git commit -s -m "feat(core): implement the Colony party identity contract"
```

---

## Task 3: Party action builders and head parsers

**Files:** Create `crates/buzz-sdk/src/party.rs`; modify `crates/buzz-sdk/src/lib.rs`

### Step 1: Write failing builder tests

- [ ] Exact three-tag action envelope, matching `build_company_action`.
- [ ] `merge` operation carries two expected heads and refuses when they are equal.
- [ ] Strict head parsers: `parse_party_event`, `parse_party_alias_event`,
  `parse_party_relationship_event`, each asserting tags agree with content.
- [ ] A party head whose `identifier` tags do not match its `identifiers` array
  is refused, so a query index can never disagree with the record.

### Step 2: Implement and prove

```bash
cargo test -p buzz-sdk party --no-fail-fast
git commit -s -m "feat(sdk): build and parse Colony party envelopes"
```

---

## Task 4: Broker party actions in the relay

**Files:** Create `crates/buzz-relay/src/party_broker.rs`; modify
`crates/buzz-relay/src/handlers/ingest.rs`, `crates/buzz-relay/src/lib.rs`;
create `migrations/0030_party_action_claims.sql`

### Step 1: Write failing relay tests

- [ ] Only kind `40015` reaches the broker.
- [ ] Non-owners are refused with no stored record.
- [ ] A legitimate owner request that loses gets a durable receipt.
- [ ] Stale expected head is a conflict; replay returns the original receipt.
- [ ] A `merge` writes the survivor and the alias in one transaction, or neither.
- [ ] Client-authored `30182` and `30183` events are rejected outright.

### Step 2: Implement

- [ ] Mirror `company_broker.rs` structurally, including `head_timestamp`.
  **A replacement head must be strictly newer than the head it replaces.** Phase
  1A shipped that bug and it broke initiative activation entirely; the same
  mistake here would break merge chains the same way.
- [ ] Reuse the idempotency-claim table shape; a merge claims once for both heads.
- [ ] Add `30182`, `30183`, and `40016` to the relay's scope and routing tables
  and to the search-exclusion list, exactly where the company kinds appear.

### Step 3: Prove and commit

```bash
cargo test -p buzz-relay party --no-fail-fast
just test-integration
git commit -s -m "feat(relay): broker owner-authorized party mutations"
```

---

## Task 5: Deterministic identity resolution

**Files:** Create `crates/buzz-sdk/src/party_resolution.rs`

The function that decides whether an observation is someone already known.

### Step 1: Write failing tests

- [ ] An exact identifier match on the same scheme resolves to the existing Party.
- [ ] Matching text under different schemes does **not** resolve.
- [ ] No identifier match yields `NoMatch` even when display names are identical:
  two businesses can share a name, and a false merge is far more expensive to
  undo than a duplicate is to merge.
- [ ] Multiple candidate matches yield `Ambiguous` carrying every candidate,
  never a silent pick.
- [ ] Resolution is pure and derives no time or randomness.

### Step 2: Implement

```rust
pub enum PartyResolution {
    NoMatch,
    Resolved { handle: String, on: PartyIdentifier },
    Ambiguous { candidates: Vec<String> },
}
```

- [ ] `Ambiguous` is surfaced to a human as a decision, never auto-resolved.

### Step 3: Prove and commit

```bash
cargo test -p buzz-sdk party_resolution --no-fail-fast
git commit -s -m "feat(sdk): resolve an observation to a known party or refuse to guess"
```

---

## Task 6: Merge, and the handles that must survive it

**Files:** Modify `crates/buzz-sdk/src/party.rs`, `crates/buzz-relay/src/party_broker.rs`

### Step 1: Write failing tests

- [ ] A merge writes the survivor and an alias at the retired coordinate.
- [ ] `A → B` then `B → C` leaves `A` resolving to `C` transitively.
- [ ] A cycle (`A → B` then `B → A`) is refused.
- [ ] Merging a handle that is already an alias is refused.
- [ ] Relationships on the retired party are re-pointed at the survivor, and a
  relationship that would collide with an existing one on the survivor merges
  status by taking the further-progressed state rather than creating a duplicate.
- [ ] Provenance from both sides survives, ordered and deduplicated.

### Step 2: Implement resolution with a bounded chase

- [ ] `resolve_party_handle` follows aliases with a hard depth cap and returns an
  explicit error at the cap rather than looping. A cycle that slipped past
  validation must be survivable at read time.

### Step 3: Prove and commit

```bash
cargo test -p buzz-sdk party_merge --no-fail-fast
cargo test -p buzz-relay party_merge --no-fail-fast
git commit -s -m "feat(core): merge parties without losing a handle or its evidence"
```

---

## Task 7: Lead and Client as views

**Files:** Modify `crates/buzz-core/src/party.rs`, `crates/buzz-relay/src/party_broker.rs`

### Step 1: Write failing tests

- [ ] One Party carries both a `lead` and a `client` relationship at once.
- [ ] Each has independent status and owner.
- [ ] A relationship without its Party is refused.
- [ ] Cancelling the Lead leaves the Client untouched.
- [ ] A second relationship of the same kind on the same Party is refused; the
  coordinate makes that structurally impossible and the test proves it.

### Step 2: Prove and commit

```bash
cargo test -p buzz-core relationship --no-fail-fast
git commit -s -m "feat(core): make Lead and Client views over one identity"
```

---

## Task 8: Agent-first CLI

**Files:** Modify `crates/buzz-cli/src/lib.rs`; create `crates/buzz-cli/src/commands/parties.rs`

```text
buzz parties list    --company <id> [--relationship lead|client] [--status <s>]
buzz parties get     --handle <h>              # follows aliases, reports the chase
buzz parties create  --file <party.json>
buzz parties resolve --company <id> --scheme domain --value acme.example
buzz parties merge   --survivor <h> --retire <h>
buzz parties relate  --party <h> --relationship lead --status accepted
```

- [ ] `get` on a retired handle reports the survivor **and** that it followed an
  alias. Silently returning the survivor would hide a merge from an agent
  reasoning about why a record changed.
- [ ] Every read specifies `kinds`.
- [ ] Add the live runbook to `crates/buzz-cli/TESTING.md`.

```bash
cargo test -p buzz-cli parties --no-fail-fast
git commit -s -m "feat(cli): read and govern Colony parties"
```

---

## Task 9: Desktop repository and chat references

**Files:** Create `desktop/src/features/parties/{contracts,partyRepository,hooks}.ts`
and `partyRepository.test.mjs`; modify
`desktop/src/features/communities/useCommunityInit.ts`,
`desktop/src/features/discovery/types.ts`

### Step 1: Repository

- [ ] Mirror `features/company/contracts.ts` exactly, including the
  unknown-field, unknown-status, and canonical-content refusals. The two
  implementations disagreeing about what is valid is the failure mode Phase 1A
  already paid for once.
- [ ] Alias-following read: `getParty(handle)` returns the resolved Party and the
  handle actually asked for.
- [ ] Wire `resetPartyRepositoryState()` into `resetCommunityState()`.

### Step 2: Bind the Discovery UI to canonical identity

- [ ] `discovery/types.ts` `Lead` gains an optional `partyHandle`, and the
  presentation type is documented as presentation-only.
- [ ] **Do not rewrite the Discovery UI in this phase.** Phase 4 owns parity; this
  step only makes a canonical handle expressible so Phase 4 does not have to
  invent one.

### Step 3: Prove and commit

```bash
cd desktop && pnpm exec tsc --noEmit && pnpm lint && pnpm test
git commit -s -m "feat(desktop): read canonical Colony parties"
```

---

## Task 10: Run the Phase 2 proof gate

**Files:** Create `crates/buzz-test-client/tests/e2e_party_identity.rs`;
modify `TESTING.md`

### Step 1: Live relay proof

Against a real relay, real Postgres, and real signatures, following the
`e2e_company_work` runbook (its own database, its own owner key, `--test-threads=1`):

- [ ] Create a Party from a Discovery-shaped observation.
- [ ] Observe the same organization a second time under a different display name
  but the same domain, and prove resolution returns the existing handle.
- [ ] Give it a Lead relationship, then a Client relationship, and prove both
  live at once with independent status.
- [ ] Merge a duplicate into it and prove: one survivor, both provenance lists,
  the retired handle still resolving, relationships carried over without
  duplication.
- [ ] Prove a non-owner cannot create, merge, or relate.
- [ ] Prove a client-authored `30182` is rejected.
- [ ] Prove a replayed merge returns the original receipt and does not merge twice.

### Step 2: Full local gate

```bash
. ./bin/activate-hermit
cargo test -p buzz-core -p buzz-sdk -p buzz-cli --no-fail-fast
cargo test -p buzz-relay party --no-fail-fast
cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-fail-fast
cd desktop && pnpm test && pnpm exec playwright test --project=integration
cd .. && just ci
```

Report each gate separately. If infrastructure is unavailable, report the gate
as unproven rather than substituting a mock result.

### Step 3: Commit proof assets

```bash
git add crates/buzz-test-client/tests/e2e_party_identity.rs TESTING.md
git commit -s -m "test: prove Colony party identity survives merges"
```

---

## Plan self-review checklist

- [ ] Every new Nostr query specifies `kinds`.
- [ ] Every addressable event has one exact `d` tag matching its content.
- [ ] No new product page.
- [ ] Lead and Client are views, never copied party records.
- [ ] A Party cannot exist without provenance.
- [ ] Every handle ever issued still resolves, transitively, forever.
- [ ] Merge is non-destructive and idempotent under replay.
- [ ] Ambiguous resolution is a human decision, never an automatic pick.
- [ ] Replacement heads are strictly newer than the heads they replace.
- [ ] No client signs `30182` or `30183` directly.
- [ ] Community-switch state is reset or scoped.
- [ ] Discovery's UI is untouched beyond making a handle expressible.
- [ ] All commits use `-s`.
- [ ] Implemented, tested, committed, merged, deployed, and live-proven are
  reported separately.

---

## Open questions for the owner

1. **Party volume.** The plan puts canonical parties on relay-authored heads on
   the assumption of hundreds to low thousands per company. If Discovery is
   expected to accept five-figure Lead counts, say so before Task 4 and the
   storage decision changes.
2. **Who may merge.** This plan makes merge owner-only, consistent with every
   other company mutation. If a Sales lead should be able to merge duplicates
   without the owner, that is a change to the authorization model, not a detail.
3. **Person parties and privacy.** People carry personal data that
   organizations do not. This plan stores them identically. If retention or
   erasure obligations apply, they belong in the contract from the start rather
   than retrofitted after Outreach fills the table.
