# Colony Interrupt Design and Agent Hierarchy

**Date:** 2026-08-04
**Status:** Approved in conversation; written-spec review pending
**Builds on:**
[Company Operating System](2026-07-31-colony-company-operating-system-design.md),
[Chat-Native Blocks](2026-07-30-chat-native-blocks-design.md)

## Problem

Colony's agents interrupt the founder from many threads at once. Requests
for decisions, answers, credentials, and real-world actions arrive as prose
buried in walls of technical text. The founder must read every thread to
discover what the company owes them, and the Chief of Staff already
improvises "everything you owe, one place" summaries in chat because no
native surface exists. At the same time, every agent can address the founder
directly, so interrupt volume scales with headcount instead of with
importance.

This design fixes interrupt handling with three moves that only work
together:

1. **Fewer askers.** Relay-enforced agent tiers; one executive voice.
2. **Structured asks.** Typed Issue events with required fields, never prose.
3. **One ordered place.** An Open Issues queue ordered by cost of delay.

## Design principles

- **Founder attention is the scarcest resource.** The platform's product is
  revenue per unit of founder attention. Interrupts are priced, batched,
  and rationed.
- **Execution stays at the edge.** Specialists produce; leaders verify and
  decide; the executive coordinates and communicates. Enforced by toolset,
  not convention.
- **Spot-check beats pre-approval.** Autonomous decisions are visible,
  reversible, and logged with their authority. The founder reverses cheaply
  instead of approving expensively.
- **Guarantees live in the relay.** Agents sleep; the relay does not.
  Anything that must not be lost (timers, promotions, stall detection) is
  relay-enforced.
- **Structure is data, not vibes.** Tiers, delegation grants, budgets, and
  hop metrics are signed events and measurable quantities. Org changes are
  config edits justified by evidence.

## Agent tiers

Stored per agent in the company roster head. Relay validates at event
write time. Editable without a release.

| Tier | At launch | May do |
|---|---|---|
| `owner` (human) | Founder, later co-founders | Everything. Answers Issues, edits policy, messages anyone. |
| `executive` | Chief of Staff | Sole agent that DMs owners, mentions owners, and files Issues to owners. Owns cross-team initiatives and queue ordering. |
| `leader` | CTO, Marketing Lead, Sales Lead, CFO | Delegates, QAs, decides within policy, escalates to the executive. Cannot initiate contact with owners. |
| `worker` | All other agents | Executes tasks. Raises blockers to its own leader in-channel. Cannot p-tag, DM, or file Issues to owners. May reply to an owner only inside threads the owner started or where the owner mentioned them (thread-scoped, computed from ancestry). |

Enforcement:

- Relay rejects worker events that p-tag an owner, open a DM with an owner,
  or file Issues.
- Mention autocomplete respects tiers client-side: workers cannot complete
  an owner mention. Prevention at input, rejection at relay.
- Promoting an agent (for example giving the CFO a direct line) is a roster
  edit backed by hop-metric evidence, not an org-chart debate.
- The CFO stays behind the executive at launch. Budget breaches are
  hard-list escalations and cannot be silently defaulted, so the one-voice
  rule holds without financial risk.

**Structural rule: three agent tiers, never four.** No leader manages
leaders; only the executive sits above leads. Teams that outgrow a leader
split sideways into two teams.

## The interrupt primitive

### One primitive, three altitudes

A worker-to-leader raise, a leader-to-executive escalation, and an
executive-to-owner Issue are the same typed event with a different
audience. Same schema, same lifecycle, same dedupe rules. Leaders have
their own mini-queues, structurally identical to the owner's. Escalation is
re-filing upward with the chain intact, so any Issue can be walked down to
the worker who first hit the wall.

### Lifecycle

```
blocked -> raised -> escalated -> filed -> answered -> consumed
```

- **blocked**: worker hits a wall; the task enters a `waiting_on_human`
  substate visible on its initiative.
- **raised**: worker posts a structured raise to its team channel tagging
  its leader. Never a DM to an owner; the relay will not accept one.
- **escalated**: leader resolves it or re-files upward with refs attached.
- **filed**: the executive mints the owner-facing Issue. Only tier
  `executive` can.
- **answered**: an owner acts. The answer is an event signed by the owner's
  key; authority is cryptographic, not UI state.
- **consumed**: the resolution auto-posts into the origin thread,
  mentions the blocked agent, and wakes it. The Issue leaves the queue.

Every transition is a signed event. Nothing can be lost between states
without leaving evidence.

### The hop-value contract

When a raise arrives at a leader, exactly five legal outcomes:

1. **Answer it** (had the knowledge or authority; cheapest death).
2. **Kill or re-scope the task** (the ask was a symptom of a bad task).
3. **Batch it** (merge with related raises; escalate one coherent ask).
4. **Enrich and escalate** (attach options evaluated, a recommendation,
   refs; the diff between received and forwarded must be non-empty).
5. **Timeout**: the relay auto-promotes and logs an **empty hop** against
   that leader.

Escalations carry refs (thread root, task id, artifacts, options
considered), never retold summaries. Empty-hop rate per leader per category
is the standing measure of whether a management hop earns its existence.
Sustained empty hops on a category route the category around that leader.

### Fast path

Credential and external-blocker raises forward mechanically and
immediately at every hop: no leader or executive judgment can produce an
API key. These two types are exempt from the non-empty-diff rule and do
not count as empty hops. Judgment is spent only on decisions and
questions.

### Relay timers

The relay is the always-on actor and owns all time-based guarantees:

- A raise unhandled by a leader past the window auto-promotes to the
  executive.
- An escalation unhandled by the executive past the window is filed to
  owners as a bare mechanical Issue.
- Arriving escalations wake the executive (event-driven, not polling).
- Stall detection generalizes: a task stuck with no event activity past a
  threshold (for example its agent crashed) raises a relay-generated stall
  event to the owning leader, promoted like any raise if unhandled. Tasks
  cannot rot silently for any reason, human or machine.

## Issue types and schemas

Filing is schema-enforced; the executive cannot file prose. Four types.

**All types require:** initiative ref, task ref(s), origin thread ref,
filing agent, blocked agent(s), created-at, and a one-sentence
**cost-of-delay statement** in revenue terms where possible ("outreach to
47 qualified leads waits"), which doubles as the queue-ordering input.

- **Decision**: 2 to 4 options, each with a one-line consequence stating
  the exact external effect ("sends email to 47 leads"). Optional
  recommended option with one-line reasoning.
- **Question**: the question, expected answer format (choice or free
  text), and what the answer unblocks.
- **Credential**: which service, which capability needs it, where to get
  it (signup URL), and the opaque secret id it will be stored under.
  Secret input goes to the encrypted vault, never the relay. The origin
  thread receives a receipt only ("Stripe key provided").
- **External blocker**: an action only an owner can perform (pay, sign up,
  verify a domain, complete an OAuth consent), a done-signal the agent can
  verify (for example the DNS record resolves), and, for purchases, exact
  item, cost, and revenue justification.

### Bundles

One initiative with several pending asks presents as one bundle card with
N sub-asks, answerable in one sitting. Partial answers are allowed; the
bundle stays open with the remainder. The relay rejects a second Issue
with the same (initiative, need) pair; duplicates must link, so five
agents blocked on one missing key produce one Issue with five task refs.

### Default-on-timeout

Decision Issues may carry a safe default plus a window: "if unanswered,
option B executes; here is why it is reversible." An owner answer
overrides; silence executes the default and logs it.

- Company-level window setting, initial value **1 hour**, adjustable in
  settings. The same setting drives hop auto-promotion timers unless
  configured separately. The executive may propose a longer per-Issue
  window with a stated reason, logged.
- Banned on the hard list (spend, external sends, hiring, legal, deletion,
  pricing). Worst case is always internal and reversible.
- Decisions execute while owners sleep. That is the intent: founder
  unavailability becomes bounded risk instead of company freeze.

### Withdrawal

Work moves on; asks die. The executive must withdraw Issues whose task was
re-scoped or killed. Withdrawn Issues leave the queue with a receipt in the
origin thread. A queue holding dead items trains owners to ignore it, which
recreates today's failure.

## Open Issues surface

A top-level surface (sidebar entry with unresolved count badge), separate
from the Inbox. The Inbox remains for conversation; Open Issues is the
ledger of what owners owe the colony.

- **Default view**: flat, ordered by cost of delay (executive-maintained).
  Pivots: by initiative, by agent, by channel. Pivots are presentation
  only, over the same events.
- **Card anatomy**: type icon, headline ask, cost-of-delay sentence,
  initiative and filing-agent chips, age, inline answer affordance for its
  type (option buttons, text input, secret input, done-check), link into
  the origin thread, provenance chain (walk down to the original raise).
- **Inline answers land in the thread.** Answering on the card and
  replying in the thread produce the same underlying signed event. An
  owner reply in a thread that references a blocked task auto-resolves the
  linked Issue; the card is the ergonomic path, not the exclusive one.
- **Credential input** renders a secure field writing to the vault;
  the relay never carries the secret; the thread receives a receipt.
- **Push and mobile**: new-Issue push notifications reuse the existing
  push plumbing. The queue must be answerable from the mobile app; a
  founder clearing three decisions from a phone in a taxi is the speed
  story working.

## Autonomy policy

### Two lists, different physics

- **Hard list, fixed**: spend beyond budget, external sends to new
  parties, hiring or firing agents, legal or contractual commitments,
  pricing changes, data deletion, new vendor signups. Always escalates.
  Not tunable by any learning loop; changing it is a deliberate owner
  policy edit in settings.
- **Soft boundary, learned**: everything else starts escalated to the
  executive's judgment, and every answered Issue carries a "handle this
  next time" affordance that moves the boundary one category at a time on
  explicit owner signal.

### Delegation grants

"Handle this next time" mints a delegation rule: category + scope + cap,
signed by an owner key, stored as policy events. Examples: "the executive
may approve landing-page copy changes"; "Marketing Lead may spend up to
R200 per month on stock images." Grants must name an initiative, target,
or cap; loose grants are rejected at input. The executive proposes the
grant wording; the owner confirms or narrows. All grants are listed,
auditable, and revocable in one action.

### Decision trail

A leader deciding under autonomy logs in-channel: the decision, options
considered, the delegation rule cited, and **the undo path**. No stateable
undo path means no autonomy, escalate regardless of category.
Reversibility is the license for autonomy, stated per decision.

### Uncertainty trigger

Delegated category plus low model confidence still escalates. Confident
and delegated acts; unsure asks. Over-asking surfaces in the escalation
metric and gets tuned, not punished.

### Budgets

Per-team monthly budget plus per-initiative cap set at initiative
approval. Inside both, spend is autonomous and ledgered. Breaching either
is a hard escalation with no default-on-timeout. The CFO watches burn and
reports through the executive.

### Metrics

- **Escalation rate** (target 10 to 15 percent of leader decisions):
  whether the boundary sits right.
- **Overturn rate** (owner reversals of autonomous decisions): whether
  trust is deserved. Near-zero overturns with high escalation means
  loosen; rising overturns means tighten that category.
- **Empty-hop rate** per leader per category: whether each management hop
  earns its place.

The system tunes on owner reversals, which cost seconds, instead of owner
pre-approvals, which cost the day.

## Execution at the edge

- **Workers produce.** Deliverables are always authored by specialists,
  whose prompts and toolsets are the specialization.
- **Leaders verify, never produce.** QA is the leader's primary job:
  inspect evidence, run tests, reproduce results, open the deployed page.
  The line is produce versus verify. A leader that finds a one-character
  defect sends it back with the exact fix noted; authorship stays clean.
  Leaders may research only in service of answering or deciding; the
  moment research becomes a deliverable it is a task, delegated down.
- **The executive coordinates.** It rarely touches work product. It may
  assign directly to a specialist for trivial single-task initiatives.
- **Toolset per tier, enforced at the harness**: workers hold mutation
  tools (shell, file edit, deploy, send); leaders hold read and verify
  tools; the executive holds communication and planning tools. A leader
  that cannot edit files never drifts into doing the work.
- **Every task names its QA identity at creation.** No exceptions. When
  the executive assigns directly, it takes QA itself or assigns QA
  explicitly in the same act. An FYI tag is not a QA assignment. This
  closes the gap where a deliverable ships uninspected because each
  supervisor assumed the other owned it.
- **Single work-queue per worker**, ordered by initiative cost of delay,
  visible to every assigner. Work arrives from leaders and the executive;
  one queue makes contention visible instead of letting assigners trample
  each other.
- **Span of control**: a leader holds roughly 4 to 8 concurrent tasks
  before QA degrades (context-window physics). The trigger for splitting
  a team is QA quality, not headcount.
- **Hierarchy is optional per initiative.** Trivial work skips the
  machinery: the executive assigns a worker directly and takes QA. The
  structure switches on when coordination cost exists.

## Revenue discipline

- **Every initiative declares its revenue link** at creation, one required
  field, three legal values: **drives revenue** (path to money stated:
  which leads, which offer, expected value), **protects revenue** (serves
  or keeps paying clients), or **infrastructure** (must state which
  revenue work it unblocks and by when). The executive rejects proposals
  missing it.
- **Portfolio ratio is the executive's steering wheel.** A mix dominated
  by infrastructure means the company is procrastinating; new-initiative
  proposals default to sales and delivery work unless infrastructure is
  justified by a named blocked revenue path.
- **No orphan work.** The attribution chain is task to initiative to
  revenue link, complete, no exceptions. Work without an initiative cannot
  start, so busywork dies at the gate, not in a policy doc.
- **Cost of delay is stated in revenue terms**, so the owner's queue order
  is the revenue priority.

## Cost accounting

Every agent run costs money. Two billing realities, one ledger:

- **API-billed runs** record actual provider cost.
- **Subscription-billed runs** record an imputed cost at the API-equivalent
  price for the same model and tokens. Subscriptions hide burn; imputation
  un-hides it.

Every run therefore produces a ledger entry carrying the attribution chain
(run to task to initiative to revenue link, per the Company OS cost
design). Daily rollups by team, initiative, and revenue-link class feed
the daily report.

## Daily report

The executive reports **daily**, fixed shape:

1. Money in.
2. Spend by team and initiative (actual plus imputed), against budgets.
3. Pipeline movement: leads, conversations, opportunities, closed.
4. What blocked revenue today.
5. Autonomy health: escalation rate, overturn rate, empty hops, defaults
   executed, stalls detected.

The report is a Block in a fixed channel. It is the only recurring
meeting the company has; everything else is a queue item.

## Multi-human readiness

The design must never hardcode a single user:

- Humans are tier `owner`. The queue is shared; any owner can claim and
  answer; first answer wins; answers are signed, so authorship is always
  attributable.
- Default-on-timeout windows count against all owners jointly.
- Delegation grants and policy edits record which owner signed them.
- Deferred until real: routing categories to a domain owner, approval
  quorums for hard-list edits, per-owner visibility restrictions.
  Membership and identity already support multiple humans; keeping the
  data model owner-plural now is cheap, retrofitting later is not.

## Platform gap analysis

### Exists today (foundation)

Relay and signed events, NIP-29 membership, initiatives and company heads,
block-attention plumbing and `KIND_APPROVAL_REQUEST`, home inbox
machinery, encrypted agent-turn cost metrics, push notifications, managed
agent spawning with env-var injection, workflow engine.

### Built by this design (no platform blockers)

New event kinds (raise, escalation, Issue, resolution, withdrawal,
delegation grant, decision log), tier field on the roster head plus relay
write-validation, relay timer subsystem (promotions, defaults, stalls),
schema-enforced filing, the Open Issues surface with pivots and inline
answers, credential vault v1 (encrypted store, opaque ids, env-var
injection at agent spawn, following the existing auth-injection pattern),
per-run cost imputation, the daily report.

### Prerequisite programs for full autonomy (separate specs)

1. **Company Browser.** Managed persistent browser profiles: an owner logs
   into LinkedIn, Gmail, or a SaaS dashboard once interactively; session
   cookies persist in the profile; agents drive it headlessly; every agent
   session is recorded and attached to its task as evidence; owners can
   watch live and take over for logins, captchas, and OAuth consents.
   Closes three gaps at once: agent web actions, session credentials, and
   owner visibility into browser work. Automation against third-party
   terms of service (notably LinkedIn) stays behind explicit owner
   approval with a human-handoff pattern.
2. **Payment rails.** Phase 1 formalizes today's reality: purchases are
   External Blocker Issues with exact item, cost, and revenue
   justification; an owner executes. Phase 2 issues virtual cards with
   per-card limits per team where available, turning budgets from policy
   into physics.
3. **OAuth connector framework.** Guided External Blocker flow per
   service: the agent files it, the card walks the owner through consent,
   tokens land in the vault with refresh handling, agents reference them
   opaquely. One nightmare per service, once.

### Why the design ships before the prerequisites

The Credential and External Blocker types are the structured interface to
everything agents cannot yet do alone. Owners perform those actions today
anyway, scattered in prose; the design makes them queued, costed,
justified, and receipted. The prerequisite programs then arrive as
infrastructure initiatives, each carrying the revenue link that justifies
it, and progressively empty that queue.

## Failure handling

- **Sleeping agents**: relay timers promote past any sleeping hop; no
  interrupt strands.
- **Dead agents**: stall detection raises relay-generated events on
  event-silent tasks.
- **Stale asks**: mandatory withdrawal with in-thread receipts.
- **Split-brain answers**: card and thread answers are one event type; an
  owner thread reply referencing a blocked task auto-resolves the Issue.
- **Secret exposure**: secrets never enter relay events; vault ids are
  opaque; threads carry receipts only.
- **Queue trust**: dedupe at filing, bundles, withdrawal, and
  un-losability all serve one property: the queue is complete and alive,
  because the first time it lies, owners go back to reading every thread.

## Acceptance gates

1. **Tier enforcement**: a worker attempt to DM or p-tag an owner is
   rejected by the relay; a worker reply inside an owner-started thread is
   accepted; mention autocomplete hides owners from workers.
2. **Interrupt chain**: a worker raise travels raise, escalate, file,
   answer, consume end to end; the resolution posts into the origin
   thread and wakes the blocked agent; every transition has a signed
   event.
3. **Timer guarantees**: a leader left asleep past the window loses the
   raise to auto-promotion; an executive left asleep produces a
   mechanical owner Issue; an event-silent task raises a stall.
4. **Default-on-timeout**: an unanswered eligible Decision executes its
   default at the window and logs it; a hard-list Decision refuses a
   default at filing time.
5. **Dedupe and bundles**: five workers blocked on one missing key
   produce one Issue with five task refs; a same-(initiative, need)
   second filing is rejected.
6. **Credential flow**: a secret entered on a card reaches the vault,
   never appears in any relay event, and the consuming agent's tool
   receives it by opaque reference.
7. **Autonomy loop**: answering an Issue with "handle this next time"
   mints a scoped grant; a later in-scope decision is taken autonomously
   with rule cited and undo path logged; revoking the grant restores
   escalation.
8. **Cost visibility**: a subscription-billed run produces an imputed
   ledger entry; the daily report shows actual plus imputed spend against
   budgets.
9. **Live proof**: one week of real operation in which every ask reaching
   the founder arrived through the queue, ordered by cost of delay, with
   zero asks discovered by reading threads.

## Non-goals

- Leader performance dashboards (principles and metrics only; a
  measurement surface is a later spec).
- Company Browser, virtual cards, OAuth connectors (prerequisite
  programs, separate specs).
- Multi-owner routing rules and approval quorums.
- Four-tier hierarchies or leaders managing leaders.
- Client or external-human participation in the queue.
- Changing the Inbox; it remains the conversation surface.
