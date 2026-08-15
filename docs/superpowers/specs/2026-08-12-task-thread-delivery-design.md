# Task-thread delivery surface — design

## Problem

Phase 1 made a Company Task's execution durable by binding it to the existing
Job lease, checkpoint, recovery, and artifact-gated delivery protocol. The
desktop still presents the canonical task thread as ordinary conversation, so
a founder cannot tell whether work is queued, actively leased, waiting for
recovery, or delivered without reading messages and guessing.

Phase 2A gives the canonical thread a compact accountable-work surface. It is
not a task board, a second task store, or a general artifact system.

## Decision

Render a task-specific projection inside `MessageThreadPanel` whenever the
thread head carries exactly one valid `task` tag. The projection reads:

- the relay-authored Company Task head (`30181`) from the existing company
  repository; and
- the latest canonical Job head (`30191`) whose `task`, `h`, and `e` tags match
  that task, channel, and thread.

The projection is visually separate from the message rows. It contains a
compact header, accepted checkpoint/delivery rows, one primary-deliverable
card, and a small detail sheet. Conversation keeps its existing pagination,
unread, grouping, and reply behavior.

Alternatives rejected:

1. Inject Job heads into the normal message timeline. Replaceable state events
   are not conversation; doing this would distort unread counts, thread
   counters, paging, and message actions.
2. Put all task state in a detail sheet. This hides the waiting/recovery and
   delivery signals that make the canonical thread accountable.
3. Copy evidence into workspace-local tabs and treat those tabs as the task
   record. Workspace payload is device-local UI state; the relay head remains
   the system of record.

## Authoritative model and compatibility

No Company Task schema changes are introduced.

- The existing `owningTeamId` is the single accountable owner shown in the
  header. If local team metadata resolves, show the team name; otherwise show
  the stable ID. `qaPersonaId` remains the explicitly named reviewer and is
  shown separately in details.
- The selected Job filing's `instruction` is the expected deliverable. A
  legacy task without a bound Job falls back to its title and shows that no
  durable execution record exists.
- The first relay-accepted delivery artifact is primary. Remaining artifacts
  are supporting evidence. Array order is part of the accepted Job outcome.
- Legacy threads with no `task` tag render exactly as before. A missing or
  malformed Task/Job head produces a compact unavailable/legacy state rather
  than hiding the conversation.

The desktop adds a strict parser for the Phase 1 Job head. It validates
required singleton tags, canonical task/channel/thread binding, status/run
status consistency, checkpoint sequence/evidence, artifact shape, and delivery
evidence. Malformed heads are ignored, not partially trusted.

When more than one Job exists for a task, the newest valid current head wins by
`created_at`, then event ID. NIP-33 replacement is first collapsed per `d`
coordinate. Phase 2A shows one current execution, not run history.

## Execution-state projection

The UI derives state only from the accepted Job head and its lease timestamp:

| Durable record | Founder-facing state |
| --- | --- |
| no bound Job | No execution record |
| queued | Waiting for an agent |
| executing + unexpired lease | In progress |
| executing + expired lease | Recovery pending |
| recoverable | Ready to resume |
| delivered | Delivered |
| failed | Failed |
| abandoned | Stopped |

The `executing` expiry boundary is scheduled from `lease-expires`; it is not
inferred from chat activity or silence. A worker name may be shown from the
lease-holder profile when available, but never changes state truth.

## Checkpoint and delivery evidence

An accepted checkpoint row appears only when the selected head contains a
checkpoint plus `checkpoint-event` and a positive sequence. It shows the
checkpoint summary and optional progress. Opaque `resumeToken` is never shown.

A delivery row and primary deliverable appear only when the head is
`delivered`, contains `outcome-event`, and has at least one validated artifact.
The detail sheet lists the remaining supporting artifacts. These rows are UI
projections of canonical state, not new messages, so they do not affect unread
or reply behavior.

## Artifact opening

Artifact opening goes through the existing channel workspace tab registry:

- `text`: open a new read-only `artifact` tab containing the accepted inline
  text and provenance.
- `event`: fetch the exact event ID from the active relay through a bounded
  content-kind allowlist, confirm its hash and signature as well as its ID, and
  open its content in the read-only `artifact` tab with event provenance.
- `url`: open a `web` tab only when that kind is registered in the current
  build. Otherwise keep the URL visible and state that this build cannot open
  it in-app.
- `path`: never pass the reference to the local file/image readers. A worker's
  path is not relay-portable. Keep it visible as evidence with a truthful
  “not available on this device” fallback.

The new read-only `artifact` payload may be persisted in the existing local tab
registry for display convenience, but it is explicitly a cached presentation
of the relay reference. It is never published or treated as delivery proof.

Opening a supported artifact creates the tab, selects it, and switches that
channel to workspace mode. Failures leave the evidence card intact and surface
an inline error/fallback. An event fetch invalidated by a community switch is
cancelled before it can mutate workspace state in the new community.

## Task detail sheet

The compact header opens a right-side sheet containing:

- task title and stable task ID;
- accountable team and QA persona;
- Company Task state and durable execution state;
- expected deliverable;
- primary and supporting artifact references;
- canonical channel/thread link and accepted checkpoint/outcome event IDs.

It has no list of unrelated tasks, filters, queues, metrics, assignment editor,
or status mutation controls.

## Acceptance gates

1. Pure contract/model tests fail before implementation and prove task-tag
   extraction, strict Job parsing, replacement/current-run selection, every
   state (including expiry), checkpoint visibility, artifact classification,
   and old-thread fallback.
2. Workspace-opening tests prove text/event use the read-only artifact kind,
   URL requires a registered web kind, path never opens a local file/image,
   and successful opening switches the existing channel workspace surface.
3. Component/mock-desktop proof shows a task thread header, recovery state,
   checkpoint row, delivered card, detail sheet, and in-app text/event tab;
   ordinary messages remain ordinary messages.
4. Focused lint, type checking, unit tests, and the appropriate desktop build
   pass. The PR gate passes on `develop` and the merge-group gate passes before
   merge is claimed.

Mock Playwright proof demonstrates rendering and interaction only. Repository
tests with signed fixtures demonstrate parsing/query behavior only. Unless a
real Tauri desktop is exercised against a real relay in this phase, native and
relay-backed end-to-end artifact opening remain explicitly unproven. External
side effects are out of scope.

## Scope boundary

No task dashboard, board, status editing, billing, hosted fleet, playbook,
connector, broad artifact library, or external-side-effect claim is part of
Phase 2A.
