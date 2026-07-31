# Colony Company Operating System

**Date:** 2026-07-31
**Status:** Approved product design
**Product:** Colony at `colony.ainative.ventures/app`
**Foundation:** Buzz fork, owned relay, chat-native Blocks

## Summary

Colony is a place for a person or team to run a digital or service business
with agent employees. Agents are not assistants sitting beside a conventional
SaaS application. They are company employees that receive work, collaborate,
use company systems, produce deliverables, request decisions, and report
results through conversation.

Chat remains the primary operating surface. Purpose-built interfaces exist
only where dense, repeated interaction creates material value. Discovery and
Outreach qualify because users and agents need to inspect, filter, configure,
and operate structured commercial systems directly. Those surfaces remain
invokable and referenceable from chat, and their progress, decisions, replies,
reports, failures, and receipts return to the conversation as persistent
Blocks.

Colony ships with a small, opinionated company roster for digital and service
businesses. It does not guess the company's core operations. Onboarding learns
the business from its website, asks only the missing questions, and proposes
the minimum useful operating teams for approval.

Finding and selling to customers are first-class company primitives, equal in
importance to performing the work. Colony therefore includes:

- a SalesTeams-parity Discovery engine;
- durable Leads and Clients;
- a multichannel Outreach engine;
- unified Conversations and Opportunities;
- Tasks and cross-team Initiatives;
- a deterministic Cost Ledger supervised by the CFO;
- chat-native approvals, questions, reports, artifacts, receipts, and hiring
  proposals.

## Relationship to approved foundation designs

This design builds on:

- [Chat-Native Blocks Foundation](2026-07-30-chat-native-blocks-design.md),
  which defines persistent inline experiences, typed references, actions,
  receipts, attention, and the Blocks catalog;
- [Owned Relay Company Bootstrap](2026-07-31-owned-relay-company-bootstrap-design.md),
  which defines the owned community, Nostr identity, membership, agent
  identity, and Builderlab boundary.

The source repository may retain technical Buzz identifiers until a later
technical rebrand. Consumer-facing product language is Colony.

## Product principles

1. **Conversation is the operating centre.** Users direct agents, receive work,
   answer questions, grant approvals, and review results in chat.
2. **Dedicated surfaces must earn their existence.** A registry or dense
   operating interface is permitted only when it is materially better than
   chat for repeated structured work.
3. **Users and agents operate the same primitives.** An agent does not imitate
   Discovery, Outreach, accounting, or approvals by browsing and remembering
   state manually.
4. **Structure is internal; the experience stays simple.** Colony may maintain
   distinct tasks, initiatives, audiences, enrollments, conversations, and
   accounting entries without forcing the user through configuration pages.
5. **One real-world identity stays one identity.** Discovery, Leads, Clients,
   contacts, campaigns, and delivery history link to stable organizations and
   people rather than copying them.
6. **External effects require explicit authority.** Sending, spending, hiring,
   publishing, creating obligations, and activating client delivery follow
   visible policy and approval rules.
7. **Deterministic systems handle deterministic work.** Cost capture,
   scheduling, state transitions, deduplication, delivery receipts, and
   accounting inheritance are runtime responsibilities, not agent guesses.
8. **Reuse proven product work before redesigning it.** SalesTeams Discovery
   and email Outreach are ported to parity before Colony simplifies or changes
   their interaction model.
9. **Agents are added because work justifies them.** A universal business need
   does not automatically become another default employee.

## Company and work model

### Agent identity

An agent has a personal name and a role or title. Either can resolve an
`@` mention:

- `@jason` addresses the agent by name;
- `@cto` addresses the agent currently holding that role.

Role mentions resolve through stable identifiers, not displayed text. A role
change does not rewrite historical messages.

### Team membership

Agents may belong to multiple teams. Colony does not impose a rigid Department
field because a specialist may contribute to marketing, engineering,
analytics, and a client delivery team.

`@marketing-team` addresses the whole team. Team membership, not a hard-coded
department hierarchy, determines the audience.

### Team leads

Team leads are delegation and QA agents. They:

- decompose work;
- assign specialists;
- inspect evidence and deliverables;
- request corrections;
- accept or escalate results;
- report team status.

Users may address specialists directly. Direct assignment attaches the
relevant owning-team lead as QA instead of forcing all requests through the
lead.

### Tasks and Initiatives

Every Task has exactly one owning team. That team is accountable for delivery
and QA even when individual contributors also belong to other teams.

Work spanning multiple teams becomes an Initiative containing single-owning-
team Tasks. The Chief of Staff owns cross-company Initiatives by default and
may delegate initiative ownership. This provides one accountable coordinator
without creating ambiguous multi-owner tasks.

Every paid agent or tool run must have a work context. A billable action
initiated from informal chat creates a lightweight background Task and inherits
its Initiative, team, commercial purpose, and cost centre before spend occurs.

## Fixed baseline roster

The default roster contains 13 agent employees:

| Function | Agent role | Responsibility |
|---|---|---|
| Company coordination | Chief of Staff | Initiatives, cross-team delegation, singleton QA, company reports |
| Company website | Website Agent | Design, copy, build, SEO, performance, and upkeep |
| Engineering | CTO | Technical delegation, architecture, review, and QA |
| Engineering | Frontend Engineer | Interfaces and client applications |
| Engineering | Backend Engineer | Systems, data, APIs, and integrations |
| Engineering | Security Engineer | Threat modelling, identity, permissions, secrets, and security review |
| Engineering | DevOps Engineer | Infrastructure, releases, observability, reliability, and recovery |
| Marketing | Marketing Lead | Strategy, delegation, and campaign QA |
| Marketing | Content & Campaign Specialist | Social content and campaign production |
| Leads | Lead Specialist | Operates Discovery, researches, qualifies, and maintains lead quality |
| Sales | Sales Lead | Pipeline strategy, delegation, message QA, and commercial accountability |
| Sales | Outreach & Closing Specialist | Multichannel outreach, follow-up, conversations, and closing support |
| Finance | CFO | Books, margins, budgets, cash, invoicing, reconciliation, and financial control |

The baseline is editable. Users may rename agents, change memberships, replace
roles, add employees, or remove functions after onboarding.

### Deliberate omissions

Colony does not create the following by default:

- a generic Operations department;
- Client Success;
- Legal Counsel;
- People or HR;
- Data Analyst;
- Procurement;
- additional Leads or Finance managers.

These functions become employees only when the business model, regulation,
team size, workload, or risk justifies recurring specialist judgment.

## Business-specific operations

Core operations depend on what the company sells. A restaurant, factory,
agency, consultancy, and software company do not need the same operating
teams.

Onboarding proposes one or more service or production teams after learning the
business. For Horizon Labs this may produce:

- a Web Development Service Team;
- a Social Media Content Service Team.

Existing agents may be shared with those teams. A Website Agent or Frontend
Engineer can contribute to client website delivery without being duplicated.
A dedicated operating lead is created only when real delegation and review
work justify one.

## Chat-native onboarding

Onboarding is the user's first working session with the Chief of Staff, not a
multi-page setup wizard.

### Preferred path

1. The user supplies the company website.
2. Colony scans offers, customers, positioning, proof, process, locations, and
   calls to action.
3. The Chief of Staff returns a sourced Company Brief as a persistent Report
   Block.
4. Uncertain or missing facts remain visibly marked as gaps.
5. An Interview Block asks only the high-value missing questions, with
   selectable answers and free-form input.
6. The Chief of Staff proposes a Company Blueprint containing:
   - fixed roster;
   - business-specific operating teams;
   - shared memberships;
   - service and internal cost centres;
   - financial and approval defaults;
   - legal, security, contract, payment, or readiness gaps.
7. The user approves, edits, or rejects the proposal.
8. Approval seeds the company context, employees, teams, systems, and first
   company report.
9. The Chief of Staff proposes the first three high-value Initiatives with
   owning teams, expected cost, and required approvals. Nothing starts
   automatically.

If the company has no website, the conversation begins with a short structured
interview.

### Trust boundary

Website claims are sourced observations, not confirmed business truth. Colony
preserves provenance, marks uncertainty, and never invents missing pricing,
capacity, contracts, policies, or financial facts. Hiring, team creation, and
spend require approval.

## Required company capabilities

Onboarding establishes or exposes visible gaps for:

- offer, customer, pricing, and operating model;
- customer acquisition and sales;
- business-specific delivery operations;
- banking and payment readiness;
- invoicing, bookkeeping, cash, and tax-ready records;
- contracts, privacy, intellectual property, licences, and jurisdiction-
  specific obligations;
- identity, permissions, audit history, backups, and incident ownership;
- task ownership, spending authority, approvals, and business reporting.

Legal is initially a governed readiness system rather than a default autonomous
lawyer. An optional Counsel agent may prepare and review material, but
consequential legal work must support escalation to licensed human counsel.

## Product primitives and direct surfaces

### Referenceable primitives

The typed `@` picker may reference:

- Agents and Teams;
- Companies, Leads, Clients, and Contacts;
- Campaigns, Audiences, Opportunities, and Conversations;
- Tasks and Initiatives;
- Plugins;
- Blocks;
- reports and named artifacts where addressability is useful.

Only actor references trigger attention. Other references attach typed context.

### Visible registries

Agents, Blocks, Leads, Clients, and Plugins require visible catalogs or
registries. Their purpose is discovery, governance, configuration, and direct
inspection. They do not replace conversation as the normal way work begins.

### Dense operating surfaces

Discovery and Outreach receive first-class operating surfaces because users
must repeatedly browse, filter, configure, review, and compare structured
information. Those surfaces must:

- be directly usable without an agent;
- expose stable references for chat;
- permit agents to invoke the same operations;
- send progress, approvals, exceptions, replies, reports, and receipts back to
  the originating conversation;
- never become a prerequisite click-path for ordinary agent-directed work.

## Discovery primitive

### UI parity contract

The first Colony Discovery implementation reproduces the current SalesTeams
experience before redesign:

1. Businesses or People mode;
2. industry or field browsing;
3. vertical or role drill-down;
4. segment drawer with existing campaigns;
5. campaign creation with geography, criteria, quantity, cost estimate, and
   source configuration;
6. Campaign shell with Overview, Discovery, Leads, Outreach, Conversations,
   and Settings;
7. start, continue, restart, cancel, realtime progress, session history, and
   source metrics;
8. Google Maps, Directories, and Brave Search source execution;
9. Lead tiers, company/contact views, search, sort, filters, add, deduplicate,
   enrich, bulk actions, and export;
10. every loading, empty, running, paused, completed, failed, and approval
    state present in the source UI.

Colony may change colours, typography, spacing, icons, application shell,
framework adapters, and reference/chat integration. It may not remove, rename,
collapse, or redesign capabilities until side-by-side parity is proven.

### Discovery ownership boundary

Colony extracts and owns the proven SalesTeams taxonomy and discovery engine
as a structured Discovery core. Colony owns:

- the product UI;
- chat references;
- Tasks and Initiatives;
- agent invocation;
- approvals and receipts;
- Lead and Client relationships.

The engine retains structured taxonomy, search sources, discovery execution,
enrichment, evidence, deduplication, and resumable run state. This avoids both a
permanent external SalesTeams product dependency and a premature rewrite of
the working engine.

## Campaign and acquisition model

The user sees one referenceable Campaign workspace with the SalesTeams tab
structure. Internally it contains independent modules:

- one or more Discovery definitions and runs;
- campaign Lead memberships;
- governed Audience snapshots;
- one or more Outreach programs;
- Conversations and Opportunities.

This preserves a simple experience while allowing multiple searches,
retargeting experiments, and multichannel programs.

### Commercial lifecycle

1. **Candidate** — a raw company or person returned by Discovery with source
   evidence; not yet a company-owned Lead.
2. **Lead** — an accepted prospect with qualification, contacts, owner, and CRM
   state.
3. **Audience member** — a Lead selected into an explicit frozen Outreach
   audience.
4. **Enrollment** — one contact's execution state in one Outreach program.
5. **Opportunity** — a qualified commercial possibility with service, value,
   stage, owner, and next action.
6. **Client** — the external party after an approved won-deal handoff activates
   a commercial and delivery relationship.

Discovery results do not automatically become Leads unless an explicit company
policy permits it. A Lead may belong to many campaigns without duplicating its
identity. Audiences are explicit snapshots; a changed live query never silently
enrols or removes people from active Outreach.

## Leads, Clients, and stable identity

An external Organization or Person has one stable identity and provenance.
Lead and Client are relationship views around that identity:

- the Lead view contains campaign membership, qualification, CRM state,
  outreach, and Sales ownership;
- the Client view contains contracts, services, billing, delivery Initiatives,
  operating ownership, and account health.

The same party may be both a Client and a Lead, such as an existing website
client targeted for a social-content expansion. The stable handle continues to
resolve throughout the lifecycle.

### Client handoff

Marking an Opportunity won does not silently create delivery obligations. It
creates a persistent client-handoff Approval Block containing:

- won Opportunity and value;
- service and scope;
- contract and payment status;
- billing and primary contacts;
- proposed delivery team;
- start date;
- missing requirements.

Approval creates or updates the Client profile, financial context, and delivery
Initiative. It preserves all Discovery, campaign, Outreach, Conversation, and
Opportunity history.

## Multichannel Outreach primitive

Outreach is company infrastructure, not an agent memory task and not a feature
locked inside Discovery. It can begin from:

- Discovery results;
- a saved CRM segment;
- an import;
- manual selection;
- a typed chat reference.

### Shared Outreach core

The shared core contains:

- Outreach campaign or program;
- Audience snapshot;
- sequence and ordered steps;
- Enrollment;
- approval policy;
- sender or channel identity;
- generated draft or action;
- scheduled attempt;
- delivery event;
- unified Conversation;
- outcome and next action;
- consent, suppression, and opt-out state;
- attribution and cost.

### Typed channel adapters

Each sequence step names a delivery channel. A typed adapter owns its real
constraints:

- **Email:** mailbox, sender health, subject/body, threading, delivery,
  opens, replies, and unsubscribe;
- **WhatsApp:** business account, approved templates, conversation window,
  delivery/read receipts, and opt-out;
- **LinkedIn:** identity, connection or message tasks, connector limits,
  platform policy, and safe human handoff;
- **Voice or phone:** number, script, consent, recording, transcript,
  disposition, and callback;
- **SMS:** number, concise content, delivery receipt, regional rules, and STOP
  handling.

The common lifecycle is never reduced to one untyped message JSON object.
Channel-specific payloads and validation remain typed.

### Cross-channel behavior

A sequence may combine channels. Any meaningful reply, opt-out, booked meeting,
disqualification, bounce or manual stop halts remaining steps across every
channel according to policy.

The unified Conversation groups interactions around the external party and
contact while preserving each channel record and provider receipt.

### Agent and user operation

The user may directly build, review, launch, pause, or inspect Outreach.
The Sales Lead and Outreach & Closing Specialist operate the same primitive
through Tasks and chat.

Outreach returns:

- proposed-campaign Plan Blocks;
- message or sample Approval Blocks;
- prospect Reply Blocks with cross-channel context and next actions;
- campaign Report Blocks with delivery, reply, meeting, opportunity, cost, and
  channel comparison;
- immutable receipts for sends, failures, opt-outs, and state changes.

## Cost Ledger and CFO

The CFO maintains the books and financial policy. The runtime captures and
calculates usage.

### Immutable usage entry

Every paid model, image, video, search, scraping, API, delivery, infrastructure,
or subscription event records:

- provider and product;
- model or tool;
- input, output, units, and effective price;
- cost and currency;
- agent;
- Task and Initiative;
- owning team;
- Campaign, Opportunity, Client, or service when applicable;
- internal cost centre when applicable;
- accounting treatment;
- timestamp, source receipt, and pricing-version provenance.

Existing encrypted agent-turn metrics provide model, channel, session, turn,
tokens, and optional USD cost for supported runs. The Cost Ledger extends this
with business attribution, pricing fallback, non-LLM spend, and reconciliation.

### Deterministic attribution

Cost treatment is inherited from work context:

`Run → Task → Initiative → Client/service or internal cost centre`

Typical defaults:

- direct paid-client delivery → COGS;
- lead discovery, marketing, sales, and Outreach → operating expense;
- company administration and website → operating expense;
- internal product or engineering → operating expense by default;
- unclear, mixed-purpose, missing, or policy-sensitive work → Needs Review.

The company accountant may configure jurisdiction- and policy-specific
treatment, including capitalization. Colony does not invent accounting policy.

### CFO responsibilities

The CFO:

- maintains the chart of accounts and allocation rules;
- resolves Needs Review entries;
- reconciles provider invoices against usage;
- maintains revenue, invoicing, cash, and payable/receivable context;
- closes reporting periods;
- reports revenue, gross margin, operating spend, and cash;
- flags anomalies, budget risk, and unprofitable clients or services.

The CFO does not manually count tokens or reconstruct tool usage from chat.

## Structured data and conversation boundary

Colony uses a hybrid boundary:

### Relay and signed conversation

The owned relay remains authoritative for:

- conversations and threads;
- typed references;
- agent and team collaboration;
- Blocks;
- questions, approvals, actions, and receipts;
- task instructions and user decisions;
- durable evidence of what agents proposed and what users authorized.

### Owned structured cores

Structured services remain authoritative for high-volume operational records:

- Discovery taxonomy, sources, runs, candidates, and evidence;
- canonical Organizations and People;
- company Lead and Client relationships;
- Campaign memberships and Audiences;
- Outreach programs, Enrollments, delivery events, and Conversations;
- Cost Ledger entries and accounting projections.

Signed events and structured records link through stable opaque identifiers.
Sensitive credentials and raw provider secrets never enter conversation events.
Blocks carry bounded presentation data or content-addressed references, not
duplicated systems of record.

## Failure and exception handling

### Missing work attribution

Do not start paid work without a Task context. If attribution cannot be resolved,
create an Unallocated entry and a CFO Needs Review item rather than guessing.

### Missing or unreliable provider usage

Store reported cumulative usage and reliability. Apply a versioned pricing
catalog only when units are reliable. Reconcile estimates against provider
invoices and retain adjustments as separate auditable entries.

### Discovery source failure

Preserve the session, completed source results, cursor, evidence, and safe error.
Allow retry or continuation without duplicating accepted Leads.

### Outreach adapter failure

Preserve the attempted action and provider response. Retry only under the
channel's idempotency and safety rules. Never resend merely because the client
did not receive a local acknowledgement.

### Reply race

An inbound reply or opt-out atomically halts or suppresses future scheduled
steps before another channel can send.

### Missing channel authority

Keep the campaign or step in a blocked state with a persistent attention item.
Never silently choose another sender, phone number, account, or channel.

### Duplicate identity

Merge through explicit identity resolution with provenance. Preserve campaign
memberships, source evidence, conversations, and references. Never discard one
record merely because names look similar.

### Client handoff incomplete

Keep the won Opportunity and pending handoff visible. Do not activate delivery,
billing assumptions, or COGS attribution until required commitments are
approved.

## Security, privacy, and compliance

- Connector credentials remain in encrypted secret storage and are referenced
  by opaque connection identifiers.
- Each channel adapter enforces its consent, suppression, identity, timing, and
  content constraints.
- Agents receive the minimum data required for their Task.
- External messages disclose their exact destination, sender identity, content,
  timing, and approval mode before authorization.
- PII access and exports are auditable and company-scoped.
- An opt-out applies before future scheduling and across all relevant programs.
- Legal and compliance outputs distinguish preparation from licensed advice.
- Agent and user actions remain attributable to signed identities.

## Acceptance gates

### 1. Company onboarding proof

Using Horizon Labs:

1. Provide `horizonlabs.co.za`.
2. Produce a sourced Company Brief.
3. Ask only missing high-value questions.
4. Propose the fixed roster and at least two business-specific service teams.
5. Approve the blueprint.
6. Confirm teams, memberships, references, cost centres, and first report.
7. Receive three proposed Initiatives without automatic execution.

### 2. Discovery parity proof

Run the SalesTeams and Colony Discovery experiences side by side:

- every source screen, field, action, tab, state, count, filter, bulk action,
  and campaign transition is present;
- the same test fixtures yield equivalent visible states;
- only approved Colony visual and shell adaptations differ;
- direct user operation and agent invocation reach the same structured engine.

### 3. Outreach proof

Using a governed test audience:

1. Create a multichannel sequence containing at least two live adapters.
2. Review sender identities, content, timing, audience, and cost.
3. Approve according to the selected policy.
4. Observe scheduled attempts and provider receipts.
5. Receive a reply on one channel.
6. Prove all remaining cross-channel steps halt.
7. Continue the unified Conversation and record its outcome.

### 4. Lead-to-Client proof

1. Discover and accept a Lead.
2. Enrol a contact in Outreach.
3. Record a qualified reply and Opportunity.
4. Mark the Opportunity won.
5. Review and approve the persistent client-handoff Block.
6. Confirm the same stable organization reference now has a Client view.
7. Confirm its delivery Initiative, contract context, and service cost centre.

### 5. Cost Ledger proof

1. Execute pre-sale Discovery and Outreach work.
2. Prove costs inherit Sales operating expense.
3. Execute delivery work for the approved Client.
4. Prove costs inherit the Client/service and COGS.
5. Inject a missing-attribution and missing-provider-cost case.
6. Prove both remain visible for review rather than being guessed.
7. Reconcile a provider invoice and preserve the adjustment history.

### 6. End-to-end company proof

The product is not proven until a user can:

1. create the company;
2. direct employees through chat;
3. discover a real prospect;
4. run governed multichannel Outreach;
5. manage the resulting Conversation;
6. close and convert the prospect;
7. start client delivery;
8. receive a report showing revenue, acquisition spend, delivery COGS, and
   margin with traceable source records.

Automated tests, builds, isolated component screenshots, or mocked green states
do not substitute for this live proof.

## Non-goals for the first product proof

- renaming every internal Buzz crate, event, environment variable, or protocol;
- replacing Builderlab with a full self-service multi-company control plane;
- creating a default Operations, Client Success, Legal, HR, Analytics, or
  Procurement department;
- redesigning SalesTeams Discovery before parity;
- placing all structured Discovery and Outreach data directly in chat events;
- automating every possible delivery channel in the first release;
- allowing agents to make unreviewed legal, financial, hiring, spending, or
  client-obligation decisions;
- replacing the conversation-centred experience with dashboards and page
  navigation.

## Implementation planning sequence

Implementation planning begins only after this specification is reviewed as a
whole. The plan should separate proof gates rather than attempt one broad
rewrite:

1. company/work identity and reference contracts;
2. chat-native onboarding and fixed roster;
3. Task, Initiative, team ownership, and run-attribution context;
4. SalesTeams Discovery UI parity and owned core boundary;
5. Leads, Campaign shell, and Audience snapshots;
6. shared Outreach core and first typed adapters;
7. unified Conversations and Opportunities;
8. client-handoff approval and delivery Initiative creation;
9. Cost Ledger, CFO reports, and reconciliation;
10. Horizon Labs end-to-end dogfood proof.
