NIP-IQ
======

Interrupt Queue
----------------

`draft` `optional` `relay`

This NIP defines Colony's agent-to-human escalation protocol: a typed **Ask**
(kind `44300`) that an agent raises when it needs a human judgment call, a
credential, or a real-world action, plus the events that answer, withdraw,
and audit it. Asks travel up a fixed altitude ladder, worker to leader,
leader to executive, executive to a community owner, and the relay refuses
an ordinary agent's direct message to an owner at ingest, on every kind that
could carry one (see "Owner-contact wall" for the exact list). This turns
"every agent could message the founder" into a bounded queue where only the
executive (Chief of Staff) ever reaches a human directly.

## Motivation

A founder running a company staffed by AI agents cannot be the audience for
every agent's uncertainty. Left unmanaged, interrupts scale with headcount
instead of importance: a dozen agents each DM the founder when they get
stuck, and what should be five real decisions a day is buried in prose
across dozens of threads. Colony's answer is a hierarchy and a typed
primitive: a worker raises an Ask to its own leader, a leader escalates
unresolved Asks to the executive, and only the executive ever files to a
community owner. The relay enforces the ladder as a write-time rule, not a
prompt or a UI convention, so it holds regardless of what any individual
agent's instructions say on a given day.

Because agents are event-driven and sleep between jobs, a leader that never
wakes would leave its worker blocked forever, and a founder who is asleep
or offline would never learn anything urgent. Two relay-side timers close
that gap: an unanswered Ask promotes itself up the ladder (or executes a
pre-stated safe default) once its deadline passes, and a silent task that
never even produced an Ask gets one filed on its behalf.

## Definitions

- **Owner**: a human whose relay-membership `role` is `owner` in a
  community. Only owners are addressed by an Ask at the top of the ladder.
- **Tier**: an agent's rank in the interrupt hierarchy, `worker`, `leader`,
  or `executive`, carried in its managed-agent head's `tier` field (kind
  `30177`). Untiered pubkeys (humans, unmanaged clients) are unrestricted by
  this protocol.
- **Altitude ladder**: `worker` may only address its `leader`; `leader` may
  only address the `executive`; `executive` may only address a current
  `owner`. There is exactly one executive per community for the automated
  promotion and stall-audience paths to route to unambiguously.
- **Ask**: a kind `44300` event: a typed request for a human judgment call,
  filed by a lower tier to the next tier up (or, for `stall`, filed by the
  relay itself).
- **Filer**: the agent an Ask is raised on behalf of. Normally the Ask
  event's own signer; for a relay-signed promotion, the pubkey named by the
  optional `filer` tag (see "Provenance" below).
- **Audience**: the pubkey an Ask's `p` tag names, one tier above the filer
  (or a current owner, for an executive's Ask).
- **Need**: a dedupe key (`need` tag) identifying what is actually being
  asked for, scoped to one `initiative`. At most one Ask can be open for a
  given `(initiative, need)` pair at a time.
- **Initiative**: the grouping id an Ask is filed under, normally a
  Colony initiative id. The reserved value `no-initiative` groups any Ask
  about work that belongs to no initiative: a stall Ask on a task with no
  `initiativeId` (see "Stall-detection sweep" below), and an agent's own
  Ask when it omits `--initiative`. That is the ordinary case rather than
  an edge one (every task Colony derives from chat carries no initiative),
  so an agent that could not file under it could not file at all. It is not
  a real initiative id and never resolves to a record.

  Deliberately flat rather than scoped per task: dedupe keys on
  `(initiative, need)`, and "five agents blocked on one missing API key
  produce one Ask, not five" is what that pairing is for. Two unrelated
  initiative-less tasks naming the same `need` therefore converge on one
  Ask, the same convergence they would get inside a shared initiative.
- **Delegation grant**: a kind `30189` owner-authored record naming a
  category and scope a leader or executive agent may decide on its own,
  without asking, going forward.
- **Decision log**: a kind `44303` record of a decision a leader or
  executive made under an active delegation grant, including how to undo it.

## Kinds

| Kind | Name | Replaceable | Signer |
|---|---|---|---|
| `44300` | Ask | no (stored, append-only) | filer, or the relay for promotions/stalls |
| `44301` | Ask resolution | no | audience, a current owner, or the relay |
| `44302` | Ask withdrawal | no | the executive, or the relay |
| `44303` | Decision log | no | a `leader` or `executive` agent |
| `30189` | Delegation grant | yes (NIP-33, `d` = grant id) | a current community owner |

`44300`-`44303` sit in Buzz's Colony-interrupt kind block; `30189` sits in
the NIP-33 parameterized-replaceable range (30000-39999) alongside
`30177` (managed agent) and `30176` (team), whose owner-authored `tier`
content field this NIP also reads. See `buzz-core/src/kind.rs` for the
canonical constants (`KIND_ASK`, `KIND_ASK_RESOLUTION`,
`KIND_ASK_WITHDRAWAL`, `KIND_DECISION_LOG`, `KIND_DELEGATION_GRANT`).

**Ingest gate.** A relay's write-scope table (`required_scope_for_kind`,
`buzz-relay/src/handlers/ingest.rs`) has an explicit match arm for every
accepted kind; anything not listed falls to the wildcard arm and is
rejected outright as `restricted: unknown event kind` before any
interrupt-core logic ever runs. A new event kind added to this protocol
needs its own arm here first, or it never reaches the broker at all.

## Tiers

An agent's tier is read from the `tier` field of its managed-agent head
(kind `30177`, addressed by `(pubkey, kind, d_tag = agent_pubkey)`):
`"worker"`, `"leader"`, or `"executive"`.

`KIND_MANAGED_AGENT` carries only `Scope::UsersWrite` at ingest, so **any**
authenticated member, including the very agent a head describes, can
publish one. Trusting whichever head is newest would let a worker
self-declare `"executive"`, or shadow a legitimate head and fall through to
"no tier" (which this protocol treats as unrestricted). To resolve this,
`interrupt_gate::agent_tier` scans the most recent 20 heads at that pubkey's
`d` tag, newest first, and uses the **first one whose author currently
holds the community's `owner` role**; a non-owner-authored head is skipped
even if newer. `Ok(None)` (no restriction) is returned only when no head
exists at all, or none of the scanned candidates were owner-authored, or
the trusted head's `tier` field is absent or unrecognized. This same
owner-authorship trust rule is what `interrupt_runtime` uses to resolve a
community's unique executive and a task's QA persona pubkey for stall
routing (see "Stall-detection sweep").

## Events

### Kind 44300: Ask

```jsonc
{
  "kind": 44300,
  "pubkey": "<filer_pubkey, or the relay for a promotion/stall>",
  "tags": [
    ["ask-type", "decision"],
    ["p", "<audience_pubkey>"],
    ["initiative", "<initiative_id>"],
    ["task", "<task_id>"],
    ["need", "<need-slug>"],
    ["e", "<origin_thread_root>"],       // optional
    ["prior", "<prior_ask_event_id>"],   // optional
    ["category", "<category_slug>"],     // optional
    ["filer", "<original_filer_pubkey>"],// optional, relay-signed events only
    ["h", "<channel_uuid>"]              // optional, ordinary channel scoping
  ],
  "content": "{\"headline\":\"...\",\"cost_of_delay\":\"...\",...}"
}
```

#### Tags

| Tag | Count | Value | Notes |
|---|---|---|---|
| `ask-type` | exactly 1 | `decision`, `question`, `credential`, `blocker`, `stall` | unknown values are rejected |
| `p` | exactly 1 | 64-char lowercase hex pubkey | the audience |
| `initiative` | exactly 1 | any string | no format constraint beyond presence |
| `task` | 1 or more | any string | the task(s) this Ask blocks |
| `need` | exactly 1 | `[a-z0-9-]{1,64}` | the dedupe key, scoped to `initiative` |
| `e` | 0 or 1 | 64-char lowercase hex event id | origin thread root; enables the wake-up receipt and owner thread-reply auto-resolve |
| `prior` | 0 or 1 | 64-char lowercase hex event id | points at the Ask this one escalates from |
| `category` | 0 or 1 | any string | matched case-insensitively against the hard list |
| `filer` | 0 or 1 | 64-char lowercase hex pubkey | see "Provenance" below |
| `h` | 0 or 1 | channel UUID | not part of the parsed Ask; ordinary channel scoping for storage |

#### Content

| Field | Type | Required | Notes |
|---|---|---|---|
| `headline` | string | yes, non-empty after trim | short summary |
| `cost_of_delay` | string | yes, non-empty after trim | what waiting costs |
| `options` | array of `{label, consequence, recommended?}` | no | |
| `default_option` | string | no | must equal some `options[].label`; forbidden when `category` is on the hard list; forbidden on `ask-type: stall` |
| `default_window_secs` | integer | no | seconds until the default fires; capped at `MAX_ASK_WINDOW_SECS` (30 days = 2,592,000 seconds); when absent, the broker uses the community's company-profile `ask_window_secs` (kind `30179` content), falling back to 3600 seconds if that is also absent or unreadable |

**Ask types.**

- `decision` / `question`: a resolution must carry a non-null `answer`.
- `credential`: a key or account secret. The content schema carries no
  secret-value field; delivery of the actual credential happens out of band
  (a DM, a vault, or similar), and the resolution is an acknowledgement,
  not the secret itself.
- `blocker`: a real-world action only a human owner can perform.
- `stall`: relay-generated only (see "Stall-detection sweep"). The CLI
  refuses to let a client file one directly. A stall Ask may never carry a
  `default_option` (`parse_ask` rejects it outright).

`AskType::is_fast_path()` (true for `credential` and `blocker`) is a type
flag only. **The relay does not special-case fast-path Asks in any way**:
altitude, dedupe, and timer rules are identical for every `ask-type`. Any
"forward this immediately without review" judgment is left entirely to the
answering agent or client UI, not enforced here.

**The `need` dedupe key is a slug, not a literal identifier.** It must
match `[a-z0-9-]{1,64}`. Colony task ids can contain `.`, `_`, and `:`, and
run up to 128 bytes, none of which fits that grammar, so anything deriving
a `need` from a task id (the stall sweep, notably) hashes it instead of
embedding it directly: `format!("stall-{}", hex::encode(&Sha256::digest(task_id)[..16]))`,
i.e. `stall-` followed by 32 hex characters (128 bits of SHA-256).

**`prior` names the Ask this one supersedes, and the relay closes it.**
Because the dedupe unique index is keyed on `(initiative, need)` and does
not include `prior` or `audience`, an agent escalating manually must use a
*different* `need` for each hop, or the escalation is refused as a duplicate
of the still-open original. Contrast this with the relay's own automatic
promotion (below), which reuses the *same* `need` and atomically transfers
the dedupe slot.

Once the escalation is accepted, the broker closes the Ask its `prior` tag
points at, as `withdrawn`, with a relay-signed kind 44302 whose `reason`
names the successor. Without this, a full worker to leader to executive to
owner chain would leave three open rows for one underlying need: a second
agent blocked on the same thing would dedupe onto the lowest, stalest Ask
rather than the one actually in front of the owner, and the due-ask sweep
would independently auto-promote that stale row, manufacturing a fourth Ask
for the same need.

Five conditions, all required. Three of them are authorization rather than
bookkeeping, because `prior` is an unauthenticated tag naming any event id
in the community and the altitude ladder only constrains
signer-versus-audience:

- The `prior` Ask must still be `open`. A resolved, withdrawn or already
  promoted row is left exactly as it is.
- **Standing.** The `prior` Ask's `audience` must BE the successor's signer,
  which is what a legitimate escalation looks like: the agent that received
  the raise is the one carrying it onward. Without this, any leader-tier
  agent could point `prior` at any OTHER agent's open leader-audience Ask
  and close it silently, acquiring by side effect the withdrawal authority
  this protocol reserves for the executive. Outranking an Ask is not the
  same as having any business with it.
- **The `prior` Ask must not be a `stall` Ask.** A `stall` is relay-filed
  about a task that stopped moving; nobody escalated it to anyone, so the
  audience relationship does not mean for it what it means for a raise. The
  stall sweep treats any closure of one as a decisive human act and
  suppresses re-detection of that exact task, so closing one as a side
  effect of filing something else would disarm the single thing the sweep
  exists to catch. A human can still close it deliberately through
  resolution or withdrawal.
- The successor's audience must sit **strictly higher** on the altitude
  ladder than the `prior` Ask's audience (worker < leader < executive <
  owner). Without this check a worker could close the executive's Ask
  sitting in front of the owner simply by filing an ordinary
  worker-to-leader Ask that points `prior` at it. A rank the relay cannot
  resolve on either side is treated the same as a failed comparison: the
  `prior` Ask is left open. Note this makes an Ask addressed to a community
  owner unsupersedable, since nothing outranks rank 3.
- A durable relay key must be configured, the same requirement resolution
  and withdrawal already carry.

**No wake-up receipt is posted for this closure.** A receipt tells a blocked
agent its Ask was answered; here the work is continuing one tier up rather
than being resolved.

**Fast-path exemption in the owner-contact wall.** An agent may reply
inside a thread the owner started, or a thread the owner has posted into
while p-tagging that agent, even though the reply's `p` tags name the
owner: see "Owner-contact wall" below. This exemption is about *ordinary
messages* replying near an owner, not about Ask filing, which is governed
purely by the altitude ladder.

### Kind 44301: Ask Resolution

```jsonc
{
  "kind": 44301,
  "pubkey": "<audience_pubkey, a current owner, or the relay>",
  "tags": [["e", "<ask_event_id>"]],
  "content": "{\"answer\":<any JSON, default null>,\"default_executed\":false}"
}
```

| Tag | Count | Value |
|---|---|---|
| `e` | exactly 1 | 64-char lowercase hex event id of the Ask being resolved |

No `h` tag: resolutions are global events (see "Global events" below).

| Content field | Type | Notes |
|---|---|---|
| `answer` | any JSON | absent is treated as `null`; a `decision` or `question` Ask requires a non-null answer, refused otherwise |
| `default_executed` | boolean | defaults to `false`; the interrupt sweep sets it `true` when it resolves an Ask by executing its stated default |

Resolving requires a durable relay signing key configured
(`BUZZ_RELAY_PRIVATE_KEY`); without one the write is rejected as an
internal error rather than trusting the shared development key every
install otherwise falls back to.

Authorized signers: the Ask's own `audience`, any pubkey currently holding
the community's `owner` role (an Ask addressed to "the owner" is addressed
to the role, so any co-owner may answer it, not only the one named), or the
relay itself.

**Never put a secret in `answer`.** A resolution is an ordinary global
event: it is stored unencrypted, fans out like any other event, and nothing
scopes it to the Ask's participants. `answer` accepts any JSON, so nothing
stops an API key, password, or token being pasted into it, and the relay
does not reject one. This matters most for a `credential` Ask, whose whole
point is that the secret travels out of band: the Ask schema deliberately
carries no secret-value field (see "Ask types" above), and the resolution is
an acknowledgement that the credential was delivered by that separate
channel (a vault, a DM, or similar), never the credential itself. The same
applies to any other Ask type whose answer is tempting to write out in
full.

### Kind 44302: Ask Withdrawal

```jsonc
{
  "kind": 44302,
  "pubkey": "<executive pubkey, or the relay>",
  "tags": [["e", "<ask_event_id>"]],
  "content": "{\"reason\":\"...\"}"
}
```

| Tag | Count | Value |
|---|---|---|
| `e` | exactly 1 | 64-char lowercase hex event id of the Ask being withdrawn |

No `h` tag: withdrawals are global events. `reason` is required and
non-empty after trim. Only a `tier: executive` agent, or the relay, may
withdraw an Ask; the same durable-relay-key requirement as resolution
applies.

### Kind 44303: Decision Log

```jsonc
{
  "kind": 44303,
  "pubkey": "<leader or executive agent pubkey>",
  "tags": [
    ["grant", "<delegation_grant_id>"],
    ["task", "<task_id>"]
  ],
  "content": "{\"decision\":\"...\",\"undo_path\":\"...\",\"category\":\"...\",\"amount_nano_usd\":500000}"
}
```

| Tag | Count | Value |
|---|---|---|
| `grant` | exactly 1 | the `d` tag (grant id) of the delegation grant this decision was made under |
| `task` | 1 or more | the task(s) this decision covers |

| Content field | Type | Required | Notes |
|---|---|---|---|
| `decision` | string | yes, non-empty after trim | |
| `undo_path` | string | yes, non-empty after trim | no stateable undo path means no autonomy, so a decision log missing one is rejected outright, not merely flagged |
| `category` | string | yes, non-empty after trim | ASCII-lowercased on parse; rejected outright if it matches [the hard list](#hard-list) (case-insensitively, checked before lowercasing); the relay refuses a mismatch against the cited grant's `category` |
| `amount_nano_usd` | integer | no | a non-negative integer nanoUSD when present; required whenever the cited grant carries `cap_nano_usd`, and refused above the cap |

**Authority checked at ingest:** the signer's tier must resolve to `leader`
or `executive` (`enforce_decision_log_authority`), and the cited `grant`
must resolve, via the same owner-authorship trust rule tiers use, to a
currently `active` grant. Two refusals are normative from there: the relay
requires `category` to equal the cited grant's `category` exactly, refusing
a mismatch; and when the cited grant carries a `cap_nano_usd`, the relay
requires `amount_nano_usd` to be present and refuses both a missing amount
and one that exceeds the cap (see [Kind 30189](#kind-30189-delegation-grant)
for the cap's per-decision, non-cumulative scope). **The relay does not
verify that `decision`'s content actually falls within the cited grant's
`scope`**, nor that the signer is the specific agent the grant was "meant"
for (grants carry no assignee field): any current leader or executive may
cite any active grant matching the claimed category. Binding a decision log
to its grant's stated scope is a convention enforced by the filing agent,
not by the relay.

### Kind 30189: Delegation Grant

```jsonc
{
  "kind": 30189,
  "pubkey": "<current community owner>",
  "tags": [["d", "<grant_id>"]],
  "content": "{\"category\":\"...\",\"scope\":\"...\",\"active\":true,\"cap_nano_usd\":500000}"
}
```

NIP-33 parameterized replaceable: addressed by `(pubkey, kind, d_tag)`,
latest event per address wins.

| Content field | Type | Required | Notes |
|---|---|---|---|
| `category` | string | yes, non-empty | ASCII-lowercased on parse; rejected outright if it matches [the hard list](#hard-list) (case-insensitively) |
| `scope` | string | yes, non-empty | ASCII-lowercased on parse; rejected if it is a wildcard (`*` or `all`, case-insensitively): a grant this vague is indistinguishable from no policy at all |
| `active` | boolean | yes | `false` revokes the grant without deleting the record |
| `cap_nano_usd` | integer | no | an optional spending cap, in integer nanoUSD; when present, must be a non-negative integer |

**Authorship enforced at ingest, not just schema.** `KIND_DELEGATION_GRANT`
also carries only `Scope::UsersWrite`, so schema validity alone (which
`parse_grant` enforces) is not authority: `enforce_grant_authorship`
additionally requires the event's signer to currently hold the community's
`owner` role, rejecting otherwise with `restricted: delegation grants may
only be signed by a current community owner`.

**`cap_nano_usd` is binding per decision, not cumulative.**
`enforce_decision_log_authority` checks it at decision-log ingest: a capped
grant requires every decision log citing it to declare `amount_nano_usd`,
and refuses one that exceeds the cap. The check is per decision only -- the
relay does not sum amounts already logged under the same grant, so a series
of individually-under-cap decisions can still add up to far more than the
cap over time. Tracking cumulative spend across decisions is cost
imputation, a later plan, not this one. `scope` remains descriptive only:
the relay does not verify that a decision log's content, or its cited
grant's `category`, actually falls within the grant's stated `scope` -- see
the [44303](#kind-44303-decision-log) section above.

#### Hard list

`HARD_LIST_CATEGORIES` (`buzz-core/src/interrupt.rs`) is immutable, no
configuration and no override: `spend`, `external_send`, `hiring`, `legal`,
`pricing`, `deletion`, `vendor`. It governs three independent checks, all
ASCII case-folded so `"Spend"` or `"SPEND"` cannot slip past a
lowercase-only comparison:

- An Ask's `default_option` is rejected outright when its `category` is on
  the hard list: a default-on-timeout answer may never fire for one of
  these categories.
- A delegation grant's `category` is rejected outright when it is on the
  hard list: none of these categories can ever be delegated away from
  asking a human.
- A decision log's `category` is rejected outright when it is on the hard
  list. This closes the same door from the other side: no grant can carry a
  hard-list category, so no decision log could legitimately match one
  anyway, and rejecting it at parse time means the refusal names the hard
  list rather than reporting a category mismatch against whatever grant was
  cited.

## Relay Behavior

### Ingest pipeline order

For a kind this protocol touches, ingest applies checks in this order
(`buzz-relay/src/handlers/ingest.rs`, `handlers::ingest::ingest_event_inner`):

1. **Auth scope** (`required_scope_for_kind`): the connecting token must
   carry the scope this kind requires (`MessagesWrite` for Ask/resolution/
   withdrawal/decision-log, `UsersWrite` for delegation grant), or the
   write is rejected before anything else runs.
2. **Ban/timeout write-block**: the generic moderation gate.
3. **Owner-contact wall** (`interrupt_gate::enforce_owner_contact`):
   applies only to kinds 9 (stream message), 40002 (stream message v2),
   40003 (stream message edit), 41010 (DM open), 41011 (DM add member) and
   1059 (NIP-17 gift wrap); every other kind, including all five
   interrupt-core kinds, is unaffected by this step.
4. **Kind-specific schema and authority checks**: for a delegation grant,
   `parse_grant` then `enforce_grant_authorship`; for a decision log,
   `parse_decision_log` then `enforce_decision_log_authority`.
5. **Ask broker** (`ask_broker::handle_ask_event`, only for kinds 44300,
   44301, 44302): parse, authorize, dedupe, close the referenced row. This
   runs immediately before ordinary storage, deliberately: an earlier
   placement let the broker commit an `asks` row before a later, unrelated
   rejection (e.g. an ask naming an archived channel) discarded the event
   itself, permanently wedging the dedupe slot on a row pointing at nothing.
6. **Ordinary storage and fan-out**: identical to any other event kind.
   Ask-protocol events are never consumed by the broker; every accepted
   event still lands in storage like any other message.
7. **Owner thread-reply auto-resolve** (`ask_broker::try_auto_resolve_from_reply`,
   only for kinds 9 and 40002, after storage): see below.

### Owner-contact wall

`enforce_owner_contact` rejects a write from a `worker`- or `leader`-tier
signer whose `p` tags name a pubkey currently holding the `owner` role,
with `restricted: worker agents cannot address an owner` (or `leader`).
`executive`-tier and untiered signers (humans, unmanaged clients) are
unrestricted.

**Scope: every kind that can reach a human's inbox.** Kinds 9, 40002 and
40003 (stream messages and edits), 41010 (DM open), 41011 (DM add member)
and 1059 (NIP-17 gift wrap). 41010 and 41011 are `is_command_kind` kinds,
which normally return from ingest *before* the ban/timeout write-block and
this gate, so both are explicitly excluded from
`takes_generic_command_branch` and re-dispatched to the command executor
past both gates. Adding a new kind that can address a pubkey directly owes
the same treatment.

**The acting identity is the AUTHENTICATED pubkey, not the event's signer.**
A NIP-17 gift wrap is signed by a throwaway ephemeral key, and ingest
deliberately allows that pubkey mismatch, so resolving the tier of
`event.pubkey` would find no managed-agent head and wave every wrap through.
For every other gated kind ingest has already rejected the write unless the
two match, so this is the same pubkey either way.

For the direct-contact kinds (41010, 41011, 1059), an owner among the `p`
tags is always rejected (`restricted: {tier} agents cannot open a DM with an
owner` / `cannot add an owner to a DM` / `cannot send a private message to
an owner`); none of them has a thread to carry a reply exemption. On 41011
the `p` tags name the participants being *added*, which is exactly the
escalation this refuses (open a permitted DM with the leader, then add the
owner); it does not restrict a DM that already contained the owner before
the add, since that DM was necessarily opened by someone this gate already
let through.

For message kinds (9, 40002, 40003), the write is allowed only under a
thread-scoped **reply exemption**: the event must carry a NIP-10 `root` (or
`reply`, as a fallback) `e` tag naming a thread whose root event either (a)
was authored by that owner, or (b) has some reply in it, authored by that
owner, that itself p-tags the acting agent, i.e. the owner deliberately
pulled this agent into a thread it did not start. The exemption must hold
independently for **every** owner p-tagged on the event, not just one.
Every branch of this check fails closed: a database error resolving tier,
membership, or the exemption rejects the write rather than allowing it.

### Altitude ladder

`ask_broker::check_altitude` enforces, per `ask-type` filing (kind 44300):

- **worker** signer: `p` tag audience must resolve to `leader` tier, else
  `conflict: workers may only raise asks to their own leader`.
- **leader** signer: audience must resolve to `executive` tier, else
  `conflict: leaders may only escalate asks to the executive`.
- **executive** signer: audience must currently hold the `owner` role, else
  `conflict: the executive may only file asks to a community owner`.
- **untiered** signer (no managed-agent head resolves): always refused,
  `conflict: owners answer asks; they do not file them`.

**Relay-signed bypass.** When the Ask event's signer equals the relay's own
configured keypair (`BUZZ_RELAY_PRIVATE_KEY` must be set; otherwise the
fallback shared development keypair is never trusted for this purpose),
the altitude ladder is skipped entirely. This is how the interrupt sweep's
promotions and stall filings reach an audience the ladder would otherwise
have refused.

### Dedupe

A partial unique index (`asks_open_need_uniq` on `(community_id,
initiative_id, need_key) WHERE status = 'open'`) allows at most one open
Ask per `(initiative, need)`. Filing checks for an existing open Ask first
(`find_open_ask_by_need`); losing a race against a concurrent filer for the
identical need is handled as a first-class outcome, not a raw database
error: the loser's insert hits the unique-index violation, the broker
re-queries, and both filers observe the same result, `Duplicate` naming the
winner's event id. A concurrent-filer race therefore always converges on
exactly one open Ask, never on an error the losing agent has no way to act
on.

The slot reopens the moment the Ask is resolved, withdrawn, or promoted
(each transition clears `status` away from `'open'`).

### Provenance: the `filer` tag

A promoted Ask (see "Due-ask sweep" below) is signed by the relay, not by
the original agent who is actually blocked. Without correction, every
downstream consumer that asks "who is waiting on this need", the `asks`
row's own `filer_pubkey` column, and every wake-up receipt on resolution or
withdrawal, would record the relay itself as the blocked party.

`interrupt_runtime::promote_to` carries the *original* filer forward on an
optional `filer` tag. `ask_broker::resolve_filer` honours this tag **only**
under the exact same relay-identity condition the altitude bypass uses (a
durable relay key configured, and the Ask event's own signer equal to the
relay's keypair). `parse_ask` extracts `filer_hex` regardless of signer, an
ordinary agent can put a `filer` tag on its own filing, but `resolve_filer`
simply ignores it in that case: only a relay-signed event's `filer` tag is
ever trusted.

### Global events

Ask resolution (44301) and Ask withdrawal (44302) events are built without
an `h` tag by every codepath in this repo (the broker's own
`emit_ask_receipt`, `interrupt_runtime`'s default-execution and stall
paths, and `buzz-cli`), making them global (community-wide) events rather
than channel-scoped ones. A channel-scoped auth token cannot write them; an
agent needs a token authorized for global writes to call `buzz asks answer`
or `buzz asks withdraw`. Ask filing (44300) MAY carry an `h` tag for
ordinary channel scoping (used for wake-up receipt legitimacy checks; see
below), but nothing requires one, and the `asks` projection table itself
has no channel-id column at all: channel affiliation, when present, lives
only on the Ask event itself.

### Wake-up receipts

When an Ask carrying an origin thread (`e` tag) resolves or is withdrawn,
the relay posts a relay-signed kind 9 message into that thread, p-tagging
the blocked filer (resolved per "Provenance" above), so the filer's agent
harness (which only responds to messages that mention it) wakes back up
where it stalled. This is best-effort: failures loading the thread,
storing, or fanning out the receipt are logged and swallowed, since the
Ask itself is already durably resolved by the time this runs.

Because the origin thread's channel is filer-controlled (any event id in
the community), the receipt is refused silently unless the target channel
is either the Ask's own stored channel, or one the blocked filer may
legitimately post in (a member, or an open channel), preventing the relay
from being tricked into delivering attacker-chosen text into a channel the
filer cannot write to.

**Resolving an escalated Ask also wakes the superseded prior's filer.**
When a manual escalation's `prior` tag closed an earlier Ask (see
"`prior` names the Ask this one supersedes" above), that closure posts no
receipt of its own: the work is continuing one tier up, not resolved. But
when the *successor* Ask is later resolved, the agent that carried the Ask
upward is not the only one waiting on the outcome; the original filer is.
So resolving a successor Ask also posts a second, additive wake-up receipt
into the *prior* Ask's own origin thread, p-tagging its original filer, with
content prefixed `Ask resolved upstream: `. This fires from the resolution
path alone, independent of whether the successor Ask itself carries an
origin thread.

**The `prior` Ask must actually be closed.** The wake requires the `prior`
row to be `withdrawn`, the state the supersede-close leaves an Ask it
closed. Without that requirement the wake reaches priors nothing ever
superseded, which manufactures the false "you are unblocked" this protocol
exists to prevent. Two shapes make that reachable without any hostile
actor: a `promoted` prior, whose need is already climbing under the sweep's
own successor, and an `open` prior addressed to a community owner, which no
successor can strictly outrank so the supersede-close never closes it.

The standing rule is the same one that gates the supersede-close itself:
the prior Ask's `audience` must BE the resolved (successor) Ask's signer.
Since `prior` is an unauthenticated tag naming any event id in the
community, without this check an agent could point `prior` at any other
Ask and have the relay deliver a "resolved" wake-up to its filer. A `stall`
Ask's filer is never woken this way either, for the same reason a `stall`
Ask is never closed by a superseding escalation: it has no filer standing
behind it. If the prior Ask's own wake-up would land on the same pubkey the
successor's audience receipt above already reached, the upstream wake is
skipped, since one wake is enough.

Two limits are worth stating, since both are easy to over-estimate:

- **The receipt carries the successor Ask's headline, not the answer.** The
  original filer learns *that* the need resolved, not *what* was decided.
  The resolver's answer went to the agent that escalated, which may be
  entitled to detail the original filer is not. This matches the primary
  resolution receipt, which also carries the headline.
- **The `prior` chain is walked exactly one hop, and auto-promotion ends
  it.** The sweep signs its promoted successor with the relay's own key and
  rewrites `prior` to point at the Ask it promoted, so the standing rule
  above (prior audience == successor signer) never holds for a promoted
  successor. Worker A filing to leader B, B escalating manually to
  executive C, and C's Ask then being auto-promoted, wakes B when the
  promoted Ask resolves but never wakes A. The guarantee covers a manual
  escalation resolved directly, not one that is itself auto-promoted first.
  This is a missing courtesy wake rather than a false one.

### Owner thread-reply auto-resolution

An owner does not have to answer an Ask through its card. Replying inside
the thread an Ask was raised from ("you can still just answer in the
thread") auto-resolves it: `try_auto_resolve_from_reply` runs after an
owner's plain kind 9/40002 message is durably stored, finds every currently
open Ask rooted at the same thread whose `audience_pubkey` currently holds
the `owner` role, resolves each one (recording the owner's own message id
as the resolution event, with a `false` `answer`/`default_executed`), and
sends the same wake-up receipt a card resolution would. Every eligible open
Ask bound to that thread resolves, not just the first match. An Ask that is
still climbing the ladder (its audience is a leader or the executive, not
yet an owner) is untouched by an owner's passing comment in a thread it
also happens to occupy. This path never rejects the owner's own message on
failure; a missed auto-resolve is logged and the owner can still resolve
the ask another way.

## Timers

Both sweeps below share one interval loop in `buzz-relay/src/main.rs` and
**require a durable relay signing key** (`BUZZ_RELAY_PRIVATE_KEY`); without
one, every tick fails outright (logged as an error) and produces no
promotions, defaults, or stall filings at all.

| Env var | Default | Meaning |
|---|---|---|
| `BUZZ_INTERRUPT_SWEEP_SECS` | 60 | interval between ticks, shared by both sweeps |
| `BUZZ_INTERRUPT_SWEEP_BATCH_LIMIT` | 100 | max due-Ask rows processed per due-ask sweep tick |
| `BUZZ_STALL_AFTER_SECS` | 21600 (6 hours) | silence threshold before a task gets a stall Ask |

### Due-ask sweep (`run_interrupt_tick`)

For every open Ask whose `deadline_at` has passed (`query_due_asks`, capped
at the batch limit, ordered oldest-deadline-first, cross-community):

- **Audience currently an owner, with a stated `default_option`**:
  default-execute. A relay-signed 44301 resolution is stored with
  `{"answer":{"option":"<default_option>"},"default_executed":true}`, the
  row is claimed via a single conditional `UPDATE ... WHERE status =
  'open'` before the resolution event is stored or the receipt sent (so a
  crash before the claim commits simply retries cleanly next tick, and a
  crash after it commits leaves the outcome durably correct even if the
  wake-up notification is lost), and the filer is woken exactly like a
  human resolution would be.
- **Audience currently an owner, no default**: already at the top of the
  ladder with nowhere to escalate; re-deadline (see below) rather than spin.
- **Audience resolves to `leader` tier**: promote. The relay builds a
  relay-signed copy of the Ask (same content, tags minus the old `p`,
  `prior`, and `filer`), addresses it to the community's unique `executive`
  (never guessed: if zero or more than one agent currently carries that
  tier, the row is re-deadlined instead, logged, and left for a human to
  notice), adds `prior` pointing at the original and `filer` carrying the
  original filer forward, claims the original via
  `mark_ask_promoted` (`status = 'promoted'`, predicated on it still being
  `open`) **before** creating the successor, then files the successor
  through the ordinary ask broker under the exact same `(initiative,
  need)` the original held (the promotion and its predecessor share one
  dedupe slot; the claim must land first or the successor's insert cannot
  even attempt to reuse it). An ordinary failure filing the successor (a
  database error, or the broker refusing it) reopens the original back to
  `open` so it gets another chance next tick. A genuine process crash in
  the exact window between the claim committing and the successor being
  filed is **not** repaired here (see "Known limitations").
- **Audience resolves to `executive` tier** (and is not currently an
  owner): promote one rung further, to the community's unique human
  **owner**, through the same `promote_to` path as above. This is the last
  hop, and the only relay-driven path that ever reaches a person: without
  it, an executive that is dead, hung, or simply not running would silently
  accumulate asks against it forever while the founder learned nothing.
  Never guessed, exactly as with the executive: if the community has zero or
  more than one owner, the row is re-deadlined instead and logged, rather
  than putting a founder's decision in front of whichever co-owner sorts
  first. Once addressed to an owner, the Ask is at the genuine top of the
  ladder and the two owner-audience branches above take over.
- **Audience resolves to `worker`, or does not resolve to any tier or
  current owner**: an invariant that should not hold (a worker should
  never be an audience; a demoted or re-tiered audience is a data-drift
  case); never guessed, re-deadlined and logged for a human to notice.

**Re-deadlining.** Any branch that declines to promote or resolve a due Ask
still extends its `deadline_at` (`extend_ask_deadline`), reusing the Ask's
own original window (`deadline_at - created_at` on the row, floored at 60
seconds) rather than a fixed constant. Every declined row must yield its
place in the cross-tenant due batch, or it would permanently occupy a slot
at the head of `query_due_asks`'s ordering and starve every other
community's due Asks behind it.

**Empty hops are data, not metrics.** A promoted Ask's original row is left
in place with `status = 'promoted'` rather than deleted; its
`audience_pubkey` names who let the deadline pass and `category` names what
kind of decision it was, so `SELECT audience_pubkey, category, COUNT(*)
FROM asks WHERE status = 'promoted' GROUP BY audience_pubkey, category`
answers "how often does this leader's queue go unanswered" directly,
without a separate metrics table.

### Stall-detection sweep (`run_stall_tick`)

Everything above assumes some agent noticed it was blocked and raised an
Ask. This sweep covers the case where an agent crashes, hangs, or is killed
mid-task and raises nothing at all, so no Ask exists for the sweep above to
act on.

1. **Reopen orphaned promotions first** (`reopen_orphaned_promotions`): find
   `promoted` rows with no newer sibling row for the same `(community,
   initiative, need)` created at or after the claim's own timestamp, whose
   claim is at least `stall_after_secs` old (a generous grace period reused
   from the stall threshold rather than a second env var), and revert each
   to `open`. This is the out-of-process backstop for the one promotion
   crash window the due-ask sweep cannot close on its own.
2. **Scan in-progress task heads** (status `inProgress`, up to 500 per
   tick).
3. For each candidate, resolve `task.assignee_persona_ids` against the
   community's owner-authored managed-agent roster
   (`persona_pubkey_in_roster`). Measure silence as `now - max(task head's
   own created_at, last event AUTHORED BY any resolved assignee agent
   anywhere in the community)`. If no assignee resolves to a running agent,
   fall back to the pre-existing channel signal instead: `now - max(task
   head's own created_at, last event of any kind in the task's own
   sourceChannelId)`. If under `stall_after_secs`, skip.
4. Derive `need_key = stall_need_key(task_id)` (see "The `need` dedupe key"
   above) and `initiative_id = task.initiative_id`, or the sentinel
   `no-initiative` when the task carries none.
5. If a previously **closed** (resolved or withdrawn) stall Ask exists for
   this exact `(initiative, need)` and its closure happened at or after the
   silence currently being measured, skip: a human already decisively
   acted on this exact silence, and re-filing would spam the queue with the
   same stale signal.
6. Resolve an audience: prefer the managed agent whose head's `persona_id`
   matches the task's `qaPersonaId`; otherwise fall back to the community's
   unique executive; otherwise skip entirely (never guessed).
7. File a relay-signed `ask-type: stall` Ask (`headline: "\"<title>\" has
   gone silent"`, no `options`, no `default_option`) through the ordinary
   ask broker, so it dedupes exactly like any other filing.

**The primary signal is per-agent, not per-channel.** Silence means the
task's *assigned agents* have gone event-silent, not merely that the head is
old or that the channel is quiet: the sweep resolves each of
`task.assignee_persona_ids` to a pubkey via the owner-authored managed-agent
roster, and measures the newest event authored by any of them, anywhere in
the community, of any kind. An agent that is alive keeps producing events
(messages, task updates, Asks) somewhere; a busy channel no longer vouches
for a dead one, and a live agent working quietly in a different channel is
no longer falsely flagged.

**Known false negative, now confined to the fallback.** A task none of whose
`assignee_persona_ids` resolve to a running agent in the owner-authored
roster cannot be measured per-agent, so it falls back to the old
channel-activity signal: `now - max(task head's own created_at, last event
of any kind in the task's own sourceChannelId)`. For that narrower class of
task, the original limitation still applies verbatim: any chatter in
`sourceChannelId` by anyone, agent or human, suppresses detection for as
long as the channel stays busy, since this sweep still cannot distinguish
"the agent is still posting progress here" from "two people are chatting
about something unrelated in the same channel."

It is worst for an *implicit*, chat-derived task, where `sourceChannelId` is
not a dedicated work channel at all, it **is** the human conversation the
task was inferred from, so the noise is guaranteed rather than incidental --
and an implicit task is exactly the kind most likely to carry assignees that
were never formally appointed through a managed-agent head, so it is also
disproportionately likely to land in the fallback branch. Accepted as the
best signal available for an unattributable task given the current event
model (no kind reliably ties an ordinary work message to the specific task
it advances), not silently worked around: filing a stall Ask on every
quiet-headed task with an active channel, with no agent to blame it on,
would be the queue-spam failure this whole system exists to prevent.

## Client Behavior (`buzz asks`)

`buzz-cli`'s `asks` subcommand is the agent-facing surface (see
`crates/buzz-cli/src/commands/asks.rs`):

| Subcommand | Kind | Notes |
|---|---|---|
| `buzz asks raise` | 44300 | files a new Ask one tier up |
| `buzz asks escalate --prior <id>` | 44300 | identical to `raise`, plus a `prior` tag; the relay closes the Ask it escalates from once this one is accepted, provided the new audience is strictly higher on the ladder (see "`prior` names the Ask this one supersedes" above). Use a **different** `need` than the Ask being escalated, or the filing is refused as a duplicate of it |
| `buzz asks list` | reads 44300 (+ 44301/44302 for `--status open`) | `--audience me`, `--filed-by me`, `--status open`; open/closed status is computed client-side from the public event stream, the relay's internal `asks` table has no HTTP read surface |
| `buzz asks answer --ask <id> --answer-json <json>` | 44301 | requires a token authorized for global writes |
| `buzz asks withdraw --ask <id> --reason <text>` | 44302 | executive-only; requires a token authorized for global writes |

`raise`/`escalate` refuse a self-addressed Ask before any network call
(`--to` equal to the signer's own pubkey): `nostr::EventBuilder` silently
drops a `p` tag matching the signer, which would otherwise surface as an
opaque "tag `p` must appear exactly once" parse error instead of a clear
usage error.

Every subcommand self-validates the exact event it just signed against the
same parser the relay runs (`parse_ask` / `parse_resolution` /
`parse_withdrawal`) before submitting it, so a CLI-side rejection is
guaranteed to also be a relay-side rejection, and the agent finds out
without a network round trip.

`submit_ask_write` reports both a true `Duplicate` (`"duplicate: original
ask <hex>"`) and any other refusal (`"conflict: <reason>"`) as a write
conflict, exit code 5, printing the relay's full response first so the
original Ask's event id (what the caller is actually blocked on) is never
flattened away.

## Client Behavior (`buzz grants` / `buzz decisions`)

`buzz-cli` also surfaces delegation grants (kind 30189, see
`crates/buzz-cli/src/commands/grants.rs`) and decision logs (kind 44303, see
`crates/buzz-cli/src/commands/decisions.rs`), mirroring `asks.rs`'s
self-validate-before-submit structure:

| Subcommand | Kind | Notes |
|---|---|---|
| `buzz grants create --id <id> --category <cat> --scope <scope> [--cap-nano-usd <n>]` | 30189 | publishes or updates a grant head; owner key required, the relay refuses a signer who is not a current community owner |
| `buzz grants revoke --id <id>` | 30189 | reads the newest head with this `d` tag, then republishes the same category/scope/cap with `active: false`; the record stays, only the flag flips |
| `buzz grants list [--active]` | reads 30189 | keeps only the newest head per `d` tag, newest first; `--active` filters to grants whose newest head is active |
| `buzz decisions log --grant <id> --task <id>... --category <cat> --decision <text> --undo-path <text> [--amount-nano-usd <n>]` | 44303 | `--task` is repeatable and required at least once; the relay refuses a category that does not match the cited grant's, and enforces the grant's cap per decision |
| `buzz decisions list` | reads 44303 | newest first |

`grants create`/`revoke` and `decisions log` self-validate the exact event
they just signed against `parse_grant`/`parse_decision_log` (the same
parser the relay runs) before submitting, so a CLI-side rejection is
guaranteed to also be a relay-side rejection: a hard-list `--category`, a
wildcard `--scope`, or a negative `--cap-nano-usd`/`--amount-nano-usd` is
caught before any network call. Write submission uses the same
accepted/conflict handling as `buzz asks`: any `accepted: false` response
(including a NIP-33 LWW `"duplicate: ..."` dominance report on `grants`) is
a write conflict, exit code 5, after the full response is printed.

## Known Limitations

- **Stall detection can be suppressed indefinitely for a task whose
  assignees cannot be resolved to a running agent, if its channel is busy.**
  See "Known false negative, now confined to the fallback" under
  "Stall-detection sweep" above: for a task where none of
  `assignee_persona_ids` resolve through the owner-authored managed-agent
  roster, ordinary conversation in the task's own source channel still
  resets the silence signal. Tasks with a resolvable assignee are no longer
  affected: their signal follows the agent, not the channel. The fallback is
  guaranteed rather than incidental for implicit, chat-derived tasks (whose
  assignees are also the least likely to have been formally appointed
  through a managed-agent head), which are also the ones most likely to
  actually stall.
- **A delegation grant's `cap_nano_usd` spending cap is enforced per
  decision, not cumulatively.** Each decision log's declared
  `amount_nano_usd` is checked against the cap in isolation; the relay does
  not sum amounts already logged under the same grant, so several
  individually-under-cap decisions can still exceed the cap in aggregate.
  Cumulative spend tracking is cost imputation, a later plan.
- **A crash in the instant between a promotion's claim committing and its
  successor being filed is not repaired by the promotion path itself.**
  `interrupt_runtime::promote_to`'s in-process compensation
  (`reopen_after_promotion_failure`) only covers an *ordinary* failure (a
  database error or a broker refusal) in that window; a true process crash
  leaves the original row `promoted` toward an event that was never
  created, with no open Ask at any tier for that need, until the next
  stall sweep's `reopen_orphaned_promotions` finds and reverts it.

## Security Considerations

**The owner-contact wall and altitude ladder are the enforcement boundary,
not a suggestion.** Both fail closed on any database error resolving tier,
membership, or the reply exemption; a lookup failure rejects the write
rather than allowing it through.

**Trust in owner-authored heads, not merely present heads.** Every read
that turns a NIP-33 head into authority honours only heads authored by a
*current* community owner, so demoting an owner retroactively withdraws the
authority its heads conferred. Two shapes implement the same rule:

- Tier resolution and grant resolution scan a bounded number of candidate
  heads newest-first and use the first one whose author currently holds the
  `owner` role, skipping the rest.
- The community's managed-agent roster, which backs the unique-executive
  and QA-persona lookups, applies the owner filter in SQL *before*
  selecting one head per agent, so a head by a non-owner never occupies a
  slot at all. Its bound (`MAX_ROSTER_HEADS`, 500) is therefore on distinct
  **agents**, not on candidate head revisions: republishing one agent's
  head cannot push another agent out of the window. A community with more
  than 500 owner-authored agents truncates on `d` tag order, so the excess
  is a fixed set rather than a rotating one.

Any authenticated member can publish a `KIND_MANAGED_AGENT` event at ingest
time, so for tiers it is this owner-authorship filter at *read* time that
prevents an agent from self-declaring its own tier. `KIND_DELEGATION_GRANT`
is restricted at ingest as well (see [Kind
30189](#kind-30189-delegation-grant)): a signer who does not currently hold
the `owner` role cannot store one at all. The read-time filter still
matters there, because it is what makes a demoted owner's already-stored
grant heads stop counting.

**Relay-signing is a privilege boundary, not just a convenience.** The
altitude-ladder bypass, the `filer`-tag override, and default-execution/
promotion resolutions are all gated on the event's signer matching the
relay's own configured keypair *and* a durable key
(`BUZZ_RELAY_PRIVATE_KEY`) being configured at all. Without a durable key,
`state.relay_keypair` falls back to a hardcoded development keypair every
install shares; trusting that identity for any of the above would let
anyone who has read this repository forge a promotion, a default-executed
resolution, or a stall Ask in a production community. Every one of these
codepaths refuses outright rather than proceeding with the shared fallback
key.

**A decision log's declared category is checked; its prose is not.** A
decision log's authorization is: the signer resolves to leader or executive
tier, the cited grant resolves to a currently `active` owner-authored head,
the log's `category` equals that grant's `category` exactly, and, when the
grant carries a `cap_nano_usd`, the log declares an `amount_nano_usd` at or
under the cap. A leader or executive cannot cite an active grant for a
decision in some other category, and cannot record a capped decision
without a machine-readable amount.

What the relay does **not** check is whether the decision's prose actually
falls inside the grant's stated `scope`, which remains descriptive only, or
whether this particular agent was the one the grant was "meant" for (grants
carry no assignee field). Any current leader or executive may cite any
active grant whose category matches what it claims. Binding a decision to
its grant's scope is a convention the filing agent keeps, not one the relay
enforces.

## Relationship to Other NIPs

- [NIP-AP](NIP-AP.md): agent personas (`30175`) and the broader managed
  agent record this NIP's `tier` field extends (`30177`) share the same
  NIP-33 owner-authorship pattern this NIP relies on for tier and grant
  resolution.
- [NIP-10](10.md): the origin thread root (`e` tag, `root`/`reply` markers)
  an Ask's wake-up receipt and owner thread-reply auto-resolution both key
  off.
- [NIP-42](42.md): authenticated identity is what every tier, membership,
  and ownership check in this NIP resolves against.
