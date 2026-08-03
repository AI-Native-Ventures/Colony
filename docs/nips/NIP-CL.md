# NIP-CL: Colony Cost Ledger

`draft` `optional`

A deterministic ledger of what a company's agents actually cost, built from
usage captured at the model-provider wire rather than from what an agent says
it spent.

## Motivation

An agent cannot be a trustworthy witness to its own cost. A buggy one
underreports, a broken one reports nothing, and a compromised one reports
whatever is convenient. NIP-AM (kind 44200) has agents publish their own token
counts, which is useful telemetry but cannot be the basis of accounting.

NIP-CL moves the measurement to a place the agent does not control: a metering
checkpoint that every agent's provider traffic passes through, holding the real
API credentials and issuing each agent an opaque virtual key in their place. An
agent that finds its own credentials finds a token that only works through the
checkpoint. What the checkpoint records is the provider's own itemization, the
same numbers the provider bills from.

NIP-AM remains valid and unchanged. Under NIP-CL it is demoted from source of
record to cross-check: a disagreement between what an agent claims and what the
wire observed is itself a signal about that agent.

`buzz ledger cross-check` performs that comparison per agent-day and exits
non-zero when either side disagrees past tolerance. The direction is the
diagnosis. An agent reporting **more** than the wire observed made calls that
never crossed the checkpoint, so it is holding a real provider credential
rather than its virtual key; an agent reporting **less** is a harness that
publishes turn metrics partially or not at all, and its money is still counted
correctly because the wire is the source of record.

Two rules keep that comparison meaningful. NIP-AM reports input tokens
*inclusive* of cache reads and writes while a usage record itemizes them, so
the wire side is summed cache-inclusive before comparing; otherwise every
cached call reads as drift. And a turn flagged `deltaReliable: false` (the
harness lost its cumulative baseline, e.g. across a restart) is excluded and
counted rather than summed, since including it manufactures drift that is an
artifact of the restart.

## Event kinds

| Kind | Name | Class | Signer | Content |
|------|------|-------|--------|---------|
| 44210 | Usage Record | regular, immutable | agent or owner | NIP-44 v2 ciphertext to owner |
| 40023 | Ledger Action | command (brokered) | owner only | canonical JSON |
| 40024 | Ledger Receipt | relay-only | relay | canonical JSON |
| 30184 | Price Book | NIP-33 head, relay-only | relay | canonical JSON, `d=pricebook` |
| 30185 | Attribution Rulebook | NIP-33 head, relay-only | relay | canonical JSON, `d=rulebook` |
| 30186 | Correction Book | NIP-33 head, relay-only | relay | canonical JSON, `d=corrections` |
| 30187 | Ledger Budget | NIP-33 head, relay-only | relay | canonical JSON, `d={costCentreId}:{period}` |

Kind 44210 is `#p`-gated and result-gated: readable only by the pubkey in its
`p` tag, including through kindless `{ids:[...]}` filters, and excluded from
NIP-50 full-text search at the storage layer. The four heads are relay-authored
plaintext, readable community-wide like party heads.

## Money representation

All amounts are **integer nanoUSD** (1e-9 USD). Rates are `u64` nanoUSD per
token; totals are `u128`. $3.00 per million tokens is `3000` nanoUSD per token.
Floating point never represents a ledger amount, at rest or in transit.

## Usage Record (kind 44210)

Content is a NIP-44 v2 ciphertext from the publisher to the owner, decoding to:

```json
{
  "source": "wire",
  "provider": "anthropic",
  "requestId": "req_011CSHoEeqs5DKb1PKBoC1fH",
  "model": "claude-sonnet-4-5",
  "timestamp": "2026-08-02T10:00:00.000Z",
  "paymentMode": "metered",
  "tokens": {
    "inputUncachedTokens": 1200,
    "cacheReadTokens": 38000,
    "cacheWrite5mTokens": 0,
    "cacheWrite1hTokens": 2100,
    "outputTokens": 750
  },
  "amountNanousd": null,
  "harness": "buzz-acp",
  "sessionId": "sess-1",
  "turnId": "turn-3",
  "httpStatus": 200,
  "description": null,
  "agentPubkey": "…hex…",
  "channelId": "…uuid…",
  "workContext": null
}
```

Rules:

- **Exactly one** of `tokens` or `amountNanousd` MUST be present. Token records
  are priced by the price book; amount records carry their own money (an
  infrastructure invoice line, a subscription seat).
- `source` is `wire` (observed by the checkpoint) or `manual` (entered by the
  owner).
- `paymentMode` is `metered` (real money per token) or `imputed` (subscription
  seat, recorded at API-equivalent prices so unit economics stay honest).
  Imputed spend is excluded from reconciliation, since it appears on no invoice.
- Token counts are the provider's own itemization. Zero means the provider
  reported zero. A call whose usage could not be parsed produces **no record**
  rather than a record of zeroes.
- `agentPubkey` is bound by the checkpoint from the authenticating virtual key.
  It is not self-reported.
- Consumers MUST ignore unknown top-level fields.
- Records are immutable. A record is never edited, replaced, or deleted; see
  Corrections.

### Token categories

The five categories map to what providers actually bill:

- `inputUncachedTokens`: input at full price.
- `cacheReadTokens`: input served from prompt cache, at the discounted rate.
  Re-sending conversation history each turn lands here, and it is real cost.
- `cacheWrite5mTokens` / `cacheWrite1hTokens`: cache writes at their own rates.
- `outputTokens`: output. Reasoning and thinking tokens are billed inside this
  count, not separately. Output has no cache tier.

Image input is converted by providers into input tokens and is already inside
the input counters.

## Dedupe

The dedupe key is:

- `wire` records: `"{provider}:{requestId}"`. The provider's own identifier for
  the call, so a republished record cannot be counted twice while two providers
  issuing the same id stay distinct.
- `manual` records: the event id, since an owner-supplied reference is not
  guaranteed unique across vendors.

First occurrence by `(created_at, event_id)` wins. A later record with the same
key and identical payload is dropped silently, which is what makes reprocessing
idempotent. A later record with the same key and different content is dropped
**and** raises a `duplicateConflict` exception, because two records disagreeing
about one charge is a fact worth surfacing.

Note that being billed repeatedly for re-sent conversation history is **not**
double counting. Each turn is a distinct request that the provider genuinely
charges for; caching is the discount, and the ledger's job is to make that
visible rather than hide it.

## Price Book (kind 30184)

```json
{"entries": [
  {"model": "gpt-5.6", "effectiveFrom": 1785628800,
   "rates": {"inputNanousdPerToken": 1000, "cacheReadNanousdPerToken": 100,
             "cacheWrite5mNanousdPerToken": 0, "cacheWrite1hNanousdPerToken": 0,
             "outputNanousdPerToken": 3000},
   "note": "80% cut"}
]}
```

- Append-only and effective-dated. A price cut, a promotional rate stacked on
  top of it, and the end of that promotion are three appended entries, never
  edits. A call made last month prices at what it actually cost.
- The rates in force at instant `t` are those of the entry with the greatest
  `effectiveFrom <= t`. Among entries sharing a timestamp, the latest appended
  wins.
- An entry is in force **at** its own `effectiveFrom` (inclusive).
- A model with no entry at or before the call instant is **unpriced**. The
  tokens are still recorded; the money is `null` and the entry is forced to
  Needs Review. A new model can never silently cost zero.
- Prices are data on the relay. Adding a model or a promotional rate is an
  owner action, never an application release.

## Attribution Rulebook (kind 30185)

A rule matches when **every** matcher it sets equals the record's field; unset
matchers are wildcards. Matchable fields: `provider`, `harness`, `model`,
`agentPubkey`, `channelId`.

Higher `priority` wins. Among equal priorities the **earliest appended** rule
wins, so adding a rule cannot silently re-route work an existing rule already
claimed. Rule ids are unique within the book; the relay refuses a duplicate.

## Correction Book (kind 30186)

```json
{"corrections": [
  {"id": "c1", "usageRecordEventId": "…64 hex…",
   "assign": { /* company, cost centre, team, purpose, client, task */ },
   "reason": "was billable client work", "correctedAt": 1785628800}
]}
```

A correction re-attributes exactly one usage record. The record is never
modified: the engine keeps both `originalClassification` and
`effectiveClassification` on the resulting entry, so a correction adds evidence
rather than replacing it. `reason` is required, because an unexplained
restatement is not an audit trail. The last correction naming a record wins.

## Ledger Budget (kind 30187)

`{"costCentreId": "web-delivery", "period": "2026-08", "amountNanousd": 500000000000}`

Addressed by `d={costCentreId}:{period}` where period is `YYYY-MM`. Unlike the
books, a budget head is last-write-wins: it states the current limit, and the
relay event store keeps the history.

## Ledger Action (kind 40017) and Receipt (kind 40018)

The action envelope carries exactly three tags:

```
["p", "<relay pubkey>"]
["a", "<target coordinate>"]
["ledger-action", "1", "<operation>", "<requestId>", "<idempotencyKey>"]
```

Operations: `add-price-entry`, `add-rule`, `add-correction`, `set-budget`.
Content is canonical JSON carrying `schema`, `operation`, `requestId`,
`idempotencyKey`, `target`, `expectedHead`, and `payload`. Tags and content MUST
describe the same request; a relay MUST refuse any disagreement.

The receipt carries four tags:

```
["p", "<owner pubkey>"]
["e", "<action event id>", "", "ledger-action"]
["a", "<target coordinate>"]
["ledger-receipt", "1", "<requestId>", "<idempotencyKey>", "<outcome>"]
```

Outcomes: `applied`, `conflict`, `failed`. **Every validation refusal is
reported as `conflict`**, matching the party contract, the `conflict:` client
message prefix, and CLI exit code 5.

### Relay behaviour

1. **Owner only.** The action author MUST be the community's current human
   owner. The check runs inside the commit transaction under the same
   `FOR UPDATE` that ownership transfer takes, and separately refuses a pubkey
   that is a registered agent, since an owner row alone does not prove humanity.
   Refusal message: `ledger actions require the community owner`.
2. **Target agreement.** The `a` tag MUST address the coordinate the payload
   itself derives, or an action prepared for one book could commit against
   another.
3. **Idempotency first.** A durable claim keyed by `(community, idempotencyKey)`
   is answered before the compare-and-set contract, so a retry returns the
   original result instead of failing as a stale head.
4. **Compare-and-set.** `expectedHead` absent means the book must not exist yet;
   present means it must be exactly that event. This is what stops two
   concurrent appends from losing one.
5. **Append, never accept.** The relay reads the stored book, appends exactly
   one record, and writes the result. It never accepts a whole book from a
   caller, which makes append-only structural rather than a rule someone has to
   honour. A stored book that fails to parse is an error, never a silent reset.
6. **Atomic commit.** Action, head, and receipt commit in one transaction or
   none of them do.

Refusal messages are stable strings:

| Message | Cause |
|---------|-------|
| `ledger actions require the community owner` | Author is not the human owner |
| `that ledger book does not exist yet` | `expectedHead` set, no stored book |
| `that ledger book already exists` | `expectedHead` absent, book exists |
| `the ledger book changed since this request was prepared` | Compare-and-set lost |
| `rule id already exists` | Duplicate rule id |
| `correction id already exists` | Duplicate correction id |
| `price entry model must be non-empty` | Blank model |
| `correction must reference a usage record event id` | Malformed event id reference |
| `correction must state a reason` | Blank reason |
| `budget period must be YYYY-MM` | Malformed period |

## The engine

Computing a ledger is a pure function of records plus the four books. It reads
no clock and uses no randomness, which is what makes a report reproducible from
the same evidence months later. The ordering is normative:

1. **Sort** by `(created_at, event_id)`. Caller order never matters.
2. **Dedupe** per the rules above.
3. **Price**: token records through the price book at the record's own
   timestamp; amount records use their stated amount. An unparseable timestamp
   falls back to the event `created_at` and raises `badTimestamp`. An unpriced
   model yields `null` cost, raises `unpricedModel`, and forces Needs Review:
   money that cannot be counted cannot be attributed.
4. **Attribute**: explicit `workContext` if present, else the winning rule, else
   Needs Review.
5. **Correct**: the last correction naming the record replaces the effective
   classification and assignment. The original classification never changes.
6. **Aggregate**: totals by effective classification, the metered/imputed split,
   spend per cost centre (unattributed money under `needs-review`), metered wire
   spend per provider-day, and budget actuals per `(costCentre, period)`.

Classification itself is the existing deterministic `classifyCost`: client
delivery with a named client is COGS, client delivery without one is Needs
Review, and internal purposes are OPEX.

## Reconciliation

Ledger metered daily sums are compared against the provider's own reported cost
per provider-day. A difference within tolerance passes, absorbing provider
rounding. Beyond tolerance it is an exception whose **direction is the
diagnosis**:

- Ledger above provider: a request was probably counted twice.
- Provider above ledger: a price entry is stale, usage records are missing, or
  the provider key is being used outside Colony.

A provider-day present on only one side is always an exception. Providers are
compared separately; summing them first would let two opposite errors cancel.

This is the answer to "how do you know the ledger is right?". Not trust:
comparison against the party that charges the card.

## Scope

Only agents the harness launched are metered, because metering happens by
routing rather than by observation. Anything else on the machine (the owner's
own tooling, an unrelated editor) reaches providers directly, never touches the
checkpoint, and never enters the ledger. That is the intended boundary, and
reconciliation names the case where a company key is used outside it.

## Security considerations

- The checkpoint forwards `accept-encoding: identity`. A compressed response
  cannot be parsed, and an unparseable response is a call that is correctly
  proxied but invisible to the ledger, which is indistinguishable from an agent
  that spent nothing. Declining the compression is preferred to declining to
  measure.
- Real provider credentials live only with the checkpoint. Agents receive
  per-agent virtual keys and the checkpoint's address; the harness overwrites
  the standard provider key environment variables so an inherited real key
  cannot leak into an agent process.
- An unknown, revoked, or absent credential is refused locally by the
  checkpoint and never forwarded upstream.
- Usage records disclose a company's entire spend history. They are encrypted to
  the owner, `#p`-gated, result-gated, and excluded from full-text search.
- Only the human owner may change prices, rules, corrections, or budgets. An
  agent that could append a price entry could rewrite the cost of its own work.

## Related

- NIP-AM: Agent Turn Metric (kind 44200), demoted here to a cross-check.
- NIP-CW: Colony company work context, whose `AgentWorkContext` is the explicit
  attribution snapshot referenced above.
