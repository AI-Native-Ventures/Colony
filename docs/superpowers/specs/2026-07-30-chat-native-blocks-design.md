# Chat-Native Blocks Foundation

**Date:** 2026-07-30

**Status:** Approved product design

**First implementation target:** Desktop

## Summary

AI Native Office is operated through conversations with agents. Chat is not a
text layer placed beside a conventional SaaS product, and it is not a doorway
to CRM, finance, project-management, or approval pages. The conversation
timeline is the operating canvas.

Agents place rich, structured experiences directly into threads. A lead can
appear as a card, a set of prospects as a table, a website as an artifact
preview, a consequential outbound message as an approval, and company
performance as a report. These experiences are called **Blocks**.

Blocks are also visible in a dedicated catalog because they form the reusable
visual language of the product. The catalog answers what exists, which version
is active, who published it, and what it can do. Creating, modifying, testing,
approving, and invoking Blocks still happens through conversation.

The first implementation phase builds the Blocks foundation. It does not build
the complete Horizon Labs operating workflow. Company entities, connector
credentials, outbound delivery, finance connectors, and the full five-deal
proof are follow-on specifications built on this foundation.

## Product principles

1. **Chat is the primary operating surface.** Work begins with a message and
   returns to the thread as progress, questions, reports, artifacts, approvals,
   errors, and receipts.
2. **Rich experiences are inline.** A Block renders inside the message timeline;
   it does not send the user to a separate workflow page.
3. **Pages are registries, not operational workflows.** The Blocks catalog makes
   reusable primitives discoverable and manageable. It is not where agents'
   work is manually administered.
4. **Agents compose; users direct.** Users describe what they want. Agents choose
   or create Blocks, provide validated data, and return finished experiences.
5. **References are typed.** Agents, companies, plugins, and Blocks can all be
   mentioned in chat, but each reference has different semantics.
6. **Structure and flexibility are separated.** Native Blocks provide stable,
   safe primitives. Composite Blocks arrange those primitives into reusable
   experiences. Sandboxed code is a later escape hatch, not the starting point.
7. **External effects are explicit.** A rendered component never silently sends
   a message, publishes content, moves money, or accesses a credential.
8. **Fallbacks are permanent.** Every Block carries a readable text fallback so
   unsupported or failed clients never lose the meaning of a conversation.

## Existing Buzz foundation

Buzz already contains the architectural seed of Blocks:

- Messages are signed Nostr events with a kind, content, channel and thread
  tags, mentions, and extensible extra tags.
- The desktop timeline already dispatches selected event kinds to dedicated
  inline renderers, including diff and huddle experiences.
- The Markdown renderer already produces media, file, link-preview,
  agent-snapshot, video-review, and configuration cards.
- `buzz:config-nudge` already demonstrates the closest existing pattern: an
  agent emits structured data with a fallback, the desktop validates the
  payload and signer, and an authenticated interactive card replaces the raw
  representation.
- A reusable `Attachment` component family already provides content, media,
  actions, state, triggers, and grouped attachments.
- Threads, agent mentions, ACP agent execution, teams, handoffs, MCP tools, Git
  artifacts, reactions, and audit events already exist.

What does not yet exist is a general Block definition format, versioned catalog,
typed Block reference, safe renderer registry, generic action protocol, or
plugin-facing way to invoke a structured inline experience.

## Vocabulary

### Conversation

The durable work record. Instructions, agent collaboration, Block instances,
actions, approvals, artifacts, failures, and receipts remain in the thread.

### Agent

An actor that can be mentioned to request attention and perform work.

### Company

A durable business context that can be referenced from chat. Lead and Client
are lifecycle views of the same Company identity; conversion never creates a
second record or changes its handle.

### Plugin

A connected capability or data source. Mentioning a Plugin constrains or
requests tool use. It does not notify a person and does not execute by itself.

### Block

A reusable, versioned definition for a rich inline experience. The user-facing
name is **Block**; internal code may use `component` where technically useful.

### Block manifest

An immutable, signed definition of one Block version. It contains metadata,
input schema, primitive composition, supported actions, permissions, fallback
requirements, compatibility information, and publisher identity.

### Block instance

A Block manifest combined with validated data in a particular message. The
instance belongs to the conversation, references an exact manifest version, and
remains renderable even after a newer version becomes active.

### Block action

A signed user interaction with a Block instance. Examples include submitting a
question, selecting a table row, requesting evidence, or granting an approval.

### Block receipt

A signed result that references the action and instance. It records what
happened, whether it succeeded, and any safe output needed to update the inline
experience.

## Reference semantics

The composer uses one typed `@` picker with visually distinct candidates:

- `@developer` — **Agent**: request attention and start work.
- `@tennant-group` — **Company**: attach business context.
- `@stripe` — **Plugin**: choose or constrain a capability.
- `@lead-card` — **Block**: choose or discuss a presentation and interaction
  contract.

Only actor references trigger attention. Company, Plugin, and Block references
attach typed context to the event. The displayed text is not the authority; the
signed event carries stable identifiers in tags.

A normal Block reference resolves to its active version. Drafts and historical
instances carry explicit manifest identifiers, so version selection is never
inferred when reproducing old messages.

## Blocks catalog and workshop

**Blocks** is a visible catalog in the product navigation. It contains:

- preview;
- stable handle;
- description and supported actions;
- native, installed, or custom origin;
- publisher and trust status;
- active version, drafts, and deprecated versions;
- required permissions;
- providing Plugin, when applicable;
- compatible clients;
- recent usage.

The catalog is for discovery and governance. Selecting a Block opens its
workshop conversation with the current preview and version context. The user
works on it by talking to an agent:

> @developer update @lead-card so source evidence expands inline. Keep the
> summary compact.

The agent creates a new draft manifest, returns an inline preview using sample
data, runs the required tests, and posts the result. User feedback remains in
the workshop thread. Activation happens only after an explicit conversational
instruction or equivalent inline action.

The same Block can then be invoked elsewhere:

> @scout use @lead-card to present the ten strongest prospects.

## Two-tier Block model

### Native Blocks

Native Blocks are product-maintained presentation and interaction primitives.
They use fixed, versioned schemas and native client renderers. They provide
responsive behavior, keyboard access, accessible names, theme integration,
loading, empty, error, and disabled states. They do not accept arbitrary CSS,
HTML, JavaScript, or native commands.

The first native grammar is:

| Handle | Purpose |
|---|---|
| `@section` | Heading, rich text, description, divider, or callout |
| `@metric` | Value, unit, trend, comparison, and supporting context |
| `@details` | Label-value information and compact metadata |
| `@table` | Typed columns and rows with formatting, sorting, filtering, selection, and row actions |
| `@card` | One structured object with media, metadata, content, status, and actions |
| `@card-list` | A collection rendered as a list, grid, or carousel |
| `@chart` | Bar, line, area, or donut visualization with an accessible tabular fallback |
| `@media` | Image, video, file, gallery, document, or external preview |
| `@status` | State, progress, steps, timeline, success, warning, or failure |
| `@actions` | Buttons, menus, confirmation, and bounded action controls |
| `@question` | Single-select, multi-select, and free-form input with structured submission |

Stack, grid, spacing, divider, and responsive layout nodes are part of the
definition grammar but do not need prominent catalog entries. They are
structural tools rather than standalone experiences.

### Question behavior

`@question` supports:

- one prompt at a time;
- optional supporting text or media;
- single-select or multi-select mode;
- text options or selectable Card instances;
- minimum and maximum selection counts;
- an optional "Something else" free-form field;
- optional required free-form explanation;
- a structured Submit action;
- ordinary chat replies remain acceptable as prose for the agent, while inline
  Submit is the path that produces a schema-valid structured response;
- clear submitted, expired, and superseded states.

Submitting a Question produces a signed Block action containing selected option
identifiers and the user's text. A Question records preference or supplies
input. It never grants permission for an external side effect.

### Composite Blocks

Composite Blocks are user-, agent-, or Plugin-owned manifests assembled from
native primitives. They receive stable handles, version independently, and can
be invoked like native Blocks.

The initial out-of-box composites are:

- `@lead-card` — Company opportunity summary and evidence.
- `@approval` — exact proposed action, destination, content, and authorization.
- `@report` — metrics, chart, table, summary, and sources.
- `@artifact` — website, image, video, document, code, or other delivered work.
- `@receipt` — verified outcome of an action, delivery, or payment.
- `@brainstorm` — Section plus Question, optional media or Card List choices,
  multi-select, and free-form input.

For example:

> @accountant show July using @metric, @chart, and @table. If it works, save the
> composition as @monthly-finance-report.

## Version and publication lifecycle

Every composite Block follows:

1. **Draft** — created from an existing version or from native primitives.
2. **Validated** — manifest and example data pass schema validation.
3. **Tested** — renderer, interaction, fallback, accessibility, and
   compatibility checks pass.
4. **Active** — approved as the version resolved by the stable handle.
5. **Deprecated** — available for historical instances but unavailable for new
   implicit invocation.

Published manifests are immutable. A change always creates a new manifest and
version. Activating a version updates the catalog head atomically; it does not
rewrite existing messages. Rolling back means moving the catalog head to an
earlier tested manifest.

Simple user changes such as labels, visible fields, ordering, colors from
approved tokens, and defaults still produce a new manifest version. The agent
can make them conversationally, but cannot silently activate them.

Core native primitive schemas use major versions. Compatible additive changes
retain the major version. A breaking primitive change creates a new major
version and cannot invalidate manifests built against the previous one.

## Event and storage model

Blocks remain Nostr-first and preserve regular Buzz conversation behavior.

### Immutable Block manifest

`KIND_BLOCK_MANIFEST` uses custom kind **40012**. It is a regular immutable
event whose JSON content contains:

- schema identifier;
- stable Block handle;
- semantic version;
- name and description;
- origin and publisher;
- input JSON Schema;
- primitive composition tree;
- action declarations;
- permission declarations;
- fallback template;
- supported client and primitive versions;
- example payloads used for preview and testing.

### Catalog head

`KIND_BLOCK_CATALOG_ENTRY` uses parameterized replaceable kind **30178** with
the stable Block handle in its `d` tag. It points to the active immutable
manifest and records catalog presentation metadata. Updating the catalog head
never mutates a manifest.

### Block instance

A Block instance remains a normal kind `9` stream message so existing channel,
thread, unread, notification, search, agent-trigger, and fallback behavior
continues to work.

- `content` contains the human-readable fallback.
- `h`, `e`, and `p` tags retain normal channel, thread, and actor semantics.
- an `e` tag with a `block` marker references the immutable manifest.
- a `block` tag carries schema version, stable handle, manifest event ID, and
  instance ID.
- a `block-data` tag carries canonical JSON instance data when it fits inside
  the bounded event size.
- larger payloads use a content-addressed `block-data-ref` tag with URL, MIME,
  SHA-256, and byte size. The fallback remains local in `content`.
- Company and Plugin references use typed addressable tags and do not become
  duplicated inline records.

The relay validates tag shape and event-size limits. The desktop validates the
manifest signature, schema, trust policy, and instance data before rendering.

### Actions and receipts

`KIND_BLOCK_ACTION` uses custom kind **40010**. It references the Block instance
and manifest, names a declared action, contains only schema-valid input, and
includes a unique idempotency key.

`KIND_BLOCK_RECEIPT` uses custom kind **40011**. It references the action and
instance and contains the terminal or current result. Receipts overlay the
instance state in the renderer and remain independently auditable.

A Question submission is a Block action. An Approval grant is also a Block
action, but requires the stronger authorization rules below.

## Rendering and action flow

1. An agent selects an active Block or an explicit draft manifest.
2. The agent obtains or produces data matching the manifest input schema.
3. The CLI or SDK validates the instance locally and publishes the kind `9`
   message with fallback and Block tags.
4. The relay validates the public envelope and stores the event.
5. The desktop loads the referenced manifest and data, validates both, then
   renders the primitive tree in the message row.
6. The user replies naturally or invokes a declared inline action.
7. The desktop signs a Block action referencing the original instance.
8. The responsible agent or permission-aware Bridge processes the action.
9. Processing publishes a receipt. The timeline materializes the receipt onto
   the original instance and may also show a concise conversational result.

No Block renderer performs the external side effect directly.

## Trust and permissions

Block trust has three initial levels:

1. **Core** — manifests and native primitives shipped with AI Native Office.
2. **Installed** — signed manifests supplied by an installed Plugin or trusted
   publisher.
3. **Workspace custom** — manifests created for the current company and approved
   by its owner.

Untrusted manifests can render only in a constrained preview using example
data. They cannot become active, request credentials, or emit executable
actions until approved.

Native renderers never expose credentials to agents or Block payloads. Plugin
credentials remain inside the connection or Bridge. Actions declare required
capabilities, and a broker checks the user, instance, action declaration,
permission, destination, payload hash, expiry, and idempotency key.

An Approval is stronger than a Question. It must show the exact consequential
action, destination, relevant content, and expiry. The resulting grant
authorizes only that hashed action once. Editing the proposed action invalidates
the earlier grant.

Arbitrary code renderers, marketplace distribution, and runtime package
installation are excluded from this phase. A later sandbox specification may
add code-backed Blocks with isolated storage, explicit capabilities, resource
limits, and no direct DOM, network, filesystem, secret, or Tauri access.

## Failure behavior

- **Unknown or unsupported Block:** render fallback text and an unobtrusive
  "Block unavailable" explanation.
- **Missing manifest:** render fallback, keep the message replyable, and offer an
  agent-addressable repair action.
- **Invalid manifest or data:** do not partially render; show fallback plus a
  safe validation error and notify the authoring agent.
- **Untrusted publisher:** preview only; actions disabled.
- **Unsupported primitive version:** fallback only; do not approximate behavior
  incorrectly.
- **Referenced external data unavailable or hash-invalid:** show fallback and a
  failed attachment state. Never use unverified data.
- **Action timeout:** retain the requested action as pending, then attach a
  timeout receipt with a conversational retry path.
- **Duplicate action or retry:** return the original receipt using the
  idempotency key; never repeat the side effect.
- **Permission denial:** attach a denied receipt explaining the missing
  capability without exposing secrets.
- **New version regression:** activation is rejected unless required tests pass;
  rollback changes only the catalog head.
- **Offline client:** queue only safe local interaction intent. Consequential
  actions require server acknowledgement before appearing complete.

## First-release scope

The first implementation phase includes:

- kind and schema registration for manifest, catalog, action, and receipt
  events;
- relay envelope validation and persistence;
- SDK and agent-first CLI commands to inspect, invoke, draft, test, activate,
  deprecate, act on, and receive Blocks;
- typed Block mention candidates and tags;
- desktop manifest loading, schema validation, caching, and renderer registry;
- the eleven native presentation primitives;
- the six initial composite Blocks;
- visible Blocks catalog and Block workshop conversation;
- version pinning, activation, rollback, and fallback behavior;
- desktop interaction, accessibility, security, and E2E coverage.

The wire format is client-independent. Desktop receives full rich rendering in
this phase. Web and mobile must preserve fallback text and unknown tags but are
not required to implement rich Block renderers yet.

This phase excludes:

- arbitrary or sandboxed code packages;
- a public Block marketplace;
- a separate operational CRM or pipeline;
- Company storage and lifecycle implementation;
- Plugin credential and connection implementation;
- email, WhatsApp, payment, or accounting Bridges;
- automated website building itself;
- technical mass-renaming of Buzz internals.

## Testing and acceptance gates

### Contract tests

- canonical manifest and instance serialization;
- schema validation for every native primitive;
- manifest signature and publisher verification;
- version compatibility and catalog-head resolution;
- bounded inline data and content-addressed external data;
- fallback generation and preservation;
- Question single-select, multi-select, custom input, and validation;
- Approval grant hashing, expiry, and one-time scope;
- action and receipt idempotency.

### Renderer tests

- every primitive in loading, empty, populated, error, disabled, and completed
  states;
- responsive layouts at supported desktop sizes;
- keyboard-only operation and screen-reader names;
- tables with formatting, sorting, filtering, selection, and row actions;
- charts with accessible table fallback;
- Card Lists in list, grid, and carousel modes;
- invalid or unknown payload fallback;
- old manifest rendering after active-version change.

### Security and fault tests

- forged publisher, mismatched manifest, malicious URLs, oversized data,
  unsupported schemas, and unexpected action identifiers;
- replay, rapid double submission, reordered receipt, stale approval, expired
  grant, and offline retry;
- attempts to request undeclared capabilities or place credentials in payloads;
- external data hash mismatch and unavailable source;
- community switch with no manifest, payload, or permission leakage.

### Real end-to-end proof

The phase is proven only when the actual desktop app, relay, SDK/CLI, and ACP
agent runtime demonstrate:

1. Scout posts a persisted `@lead-card` instance.
2. The user references `@lead-card` and asks Developer to modify it.
3. Developer publishes a tested draft preview in the workshop conversation.
4. The user requests a multi-select `@brainstorm`, chooses several options,
   adds custom input, and submits it.
5. The structured answer reaches the agent as a signed action.
6. The user activates the new Lead Card version conversationally.
7. The original message still renders its pinned earlier version after a full
   desktop restart and history reload.
8. A new Lead Card instance uses the new active version.
9. An Approval produces exactly one action under deliberate retry and
   double-click conditions.
10. A Receipt records the result and updates the original inline experience.
11. Invalid, unauthorized, missing-version, hash-invalid, timeout, and offline
    cases degrade according to this specification.

A standalone component demo, mocked-only timeline, passing unit test, or
compiled build is not sufficient proof.

## Follow-on product specifications

After the Blocks foundation passes its acceptance gate:

1. **Company primitive** — stable Company identity, typed references, Lead and
   Client lifecycle, contacts, artifacts, and payment evidence.
2. **Plugin connections and Bridge** — credentials, capabilities, permissions,
   inbound events, outbound execution, and receipts.
3. **Horizon growth loop** — prospect research, founder approval, complete
   preview rebuild, QA handoff, personalized outbound, reply handling, and
   payment matching.
4. **Company reporting** — revenue, costs, cash, delivery, content, and growth
   reports requested from agents and rendered through Blocks.

The product-level proof remains five paid Horizon Labs deals completed
end-to-end without spreadsheets or off-system tracking.
