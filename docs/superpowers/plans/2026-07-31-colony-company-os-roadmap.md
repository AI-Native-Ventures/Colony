# Colony Company Operating System Delivery Roadmap

**Design source:** `docs/superpowers/specs/2026-07-31-colony-company-operating-system-design.md`

**Purpose:** Sequence the approved product into independently provable implementation
plans without turning Colony into a collection of pages or coupling every business
primitive into one release.

## Product invariant

Chat remains the operating centre. Each phase may add:

- durable data and deterministic runtime behavior;
- agent-first CLI commands;
- inline Blocks, references, approvals, receipts, and reports;
- a dense operating surface only where the approved design explicitly requires one.

It must not add a dashboard merely because a new entity exists.

## Dependency graph

```text
Owned relay + chat-native Blocks
                |
                v
1A. Company operating kernel
    company, roles, teams, tasks, initiatives, run attribution
                |
                v
1B. Chief of Staff onboarding + approved roster bootstrap
                |
       +--------+---------+
       |                  |
       v                  v
2. Stable party/CRM   3. Deterministic cost ledger
   identity              + CFO controls
       |
       v
4. SalesTeams Discovery parity
       |
       v
5. Audience + multichannel Outreach
       |
       v
6. Conversations + Opportunities + Client handoff
       |
       v
7. Delivery operations + readiness/compliance
```

## Phase 0 — Foundation gates

Complete and prove the two already-approved foundations before company operating
work is promoted:

- `docs/superpowers/plans/2026-07-30-chat-native-blocks-foundation.md`
- `docs/superpowers/plans/2026-07-31-owned-relay-company-bootstrap.md`

The company plans may be developed against those branch contracts, but live
acceptance requires:

- the owned relay authorization boundary;
- persistent Core Blocks, actions, receipts, and Inbox attention;
- a real desktop agent turn through the owned relay.

## Phase 1A — Company operating kernel

Implementation plan:
`docs/superpowers/plans/2026-07-31-colony-company-operating-kernel.md`

Delivers:

- durable Company, Initiative, and Task event contracts;
- stable personal-name and role/title identity for agents;
- one lead per team and multi-team persona membership;
- `@name`, `@role`, and `@team` resolution;
- deterministic work context attached to agent runs;
- encrypted per-run cost attribution fields in NIP-AM metrics;
- agent-first `buzz company`, `buzz initiatives`, and `buzz tasks` commands;
- no new product page.

Proof gate: a named agent can be addressed through either identity, receive a
Task owned by one team within a cross-team Initiative, and emit an encrypted
turn metric carrying the exact Task, Initiative, team, cost-centre, and
COGS/OPEX/review classification.

## Phase 1B — Chief of Staff onboarding and roster bootstrap

Implementation plan:
`docs/superpowers/plans/2026-07-31-colony-chief-of-staff-onboarding.md`

Delivers:

- the existing identity/community onboarding unchanged;
- one Chief of Staff provisioned into the private Welcome conversation;
- safe website scan with source evidence and explicit gaps;
- Company Brief Report Block;
- Interview Block for missing facts only;
- persistent Company Blueprint approval;
- one idempotent approval transaction that creates the Company, fixed roster,
  teams, memberships, cost centres, and initial report;
- three proposed Initiatives that do not auto-run;
- no roster or company setup wizard.

Proof gate: a fresh install goes from website URL to approved company in chat,
survives close/restart at every attention state, and creates exactly one copy
of every approved record under action replay.

## Phase 2 — Stable party and CRM identity

Write the dedicated implementation plan at this gate, after the kernel's
identity and authorization contracts are proven.

Delivers:

- canonical Organization and Person identities;
- evidence-backed identity merge and deduplication;
- Lead and Client as relationship views, not copied records;
- stable reference handles through Candidate, Lead, Opportunity, and Client;
- client data boundaries ready for delivery and accounting.

Proof gate: one organization discovered twice resolves to one identity, may be
both Lead and Client, and retains one reference handle and complete provenance.

## Phase 3 — Deterministic cost ledger and CFO controls

Write the dedicated implementation plan at this gate, using proven NIP-AM work
context rather than guessing its final storage shape in advance.

Delivers:

- immutable ingestion of LLM, tool, API, infrastructure, and subscription usage;
- attribution rule engine;
- COGS/OPEX/Needs Review classification;
- reconciliation, budgets, margin, cash, and exception reports;
- CFO review Blocks and corrections that never rewrite raw usage.

Proof gate: every paid run is counted once, reprocessing is idempotent, direct
client delivery flows to COGS, internal work flows to OPEX, uncertainty appears
in Needs Review, and corrections preserve the original evidence.

## Phase 4 — SalesTeams Discovery parity

Write the dedicated implementation plan at this gate after a fresh side-by-side
inventory of the source SalesTeams build.

Source reference: `/Users/mac/Desktop/Billion/SalesTeams`

Delivers the shipped SalesTeams interaction model before redesign:

- Businesses/People;
- Industry/Field;
- Vertical/Role;
- campaigns and campaign details;
- geography, criteria, quantity, source selection, and credit estimate;
- Google Maps, Directories, and Brave Search source behavior;
- exact campaign tabs: Overview, Discovery, Leads, Outreach, Conversations,
  Settings;
- lead tiers, filters, sorting, bulk actions, dedupe, enrichment, and export;
- Colony shell, tokens, chat references, Tasks, approvals, and cost context.

Proof gate: side-by-side parity evidence demonstrates every visible field,
state, tab, source, and bulk action before any Colony-specific simplification.

## Phase 5 — Audience and multichannel Outreach

Write the dedicated implementation plan at this gate after Discovery and stable
party identity are proven.

Delivers:

- Campaign, Audience snapshot, Sequence, Step, Enrollment, Approval, Attempt,
  Delivery Event, Conversation, Outcome, consent, opt-out, and cost;
- typed Email, WhatsApp, LinkedIn, Voice, and SMS adapters;
- channel-specific constraints instead of a lowest-common-denominator message;
- global stop rules for reply, opt-out, meeting, disqualification, and manual
  stop;
- direct UI and agent use of the same primitive;
- inline plan, approval, reply, exception, and performance Blocks.

Proof gate: one frozen Audience runs through a mixed-channel sequence; a reply
on any channel stops all remaining steps exactly once and produces a persistent
conversation plus receipt.

## Phase 6 — Opportunities and Client handoff

Write the dedicated implementation plan at this gate after the shared Outreach
event model is proven.

Delivers:

- unified Conversations;
- Opportunities with stage and commercial evidence;
- won/lost outcomes;
- persistent client-handoff approval;
- approval that activates the Client view, financial context, service cost
  centre, and delivery Initiative without duplicating the Organization.

Proof gate: winning an Opportunity creates one unresolved handoff; dismissing
the review does not resolve it; approving it exactly once activates delivery
and accounting context.

## Phase 7 — Delivery operations and readiness

Write the dedicated implementation plan at this gate after Client handoff and
cost attribution are live-proven.

Delivers:

- onboarding-generated service/production teams;
- client delivery Initiatives and reports;
- evidence-based readiness checks for contracts, privacy, security, payment,
  and compliance;
- optional Counsel or other specialist proposals only when recurring work
  justifies them.

Proof gate: Horizon Labs can operate website and social-content services as
separate delivery teams using shared agents, with clear ownership, QA,
cost attribution, and readiness exceptions.

## Release discipline

Each phase reports these states separately:

1. designed;
2. implemented;
3. locally tested;
4. committed;
5. PR checks green;
6. merged;
7. deployed;
8. adopted by the live runtime;
9. live-proven through the real user path.

No later phase may make an earlier unproven state sound complete.
