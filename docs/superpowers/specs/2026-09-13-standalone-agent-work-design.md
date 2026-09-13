# Stand-alone agents and optional team ownership

## Approved product direction

On 13 September 2026 Basheer confirmed that most agents may operate without a
team. Mentioning an agent identifies who should do the work. Team membership is
optional organisation, not a prerequisite for sending, receiving, performing,
reviewing, or accounting for that agent's work.

This replaces the existing assumption that every task needs a team and a team
reviewer. It must not be implemented by fabricating a one-person team or silently
enrolling every agent in Company Coordination.

## User behaviour

- Mention one agent: send to that agent and assign the requested work directly.
  Zero, one, or several team memberships do not change the explicit recipient.
- Reply in an existing thread: preserve the existing task context. A reply does
  not require a new task or a newly selected team. An explicitly mentioned
  participant must be authorised for that thread before running against its task.
- Ordinary conversation may use a hidden accounting record when needed. It must
  not demand that the user organise a team or create a visible task.
- Explicitly assign work to a team: retain its coordination, delegation, and
  review workflow. Membership alone does not convert a direct assignment into
  a team assignment.
- An instruction without a recipient can use Scout where the product already
  offers that route. Missing team data must not secretly reroute a direct mention
  to Scout. Human chat without an instruction does not automatically summon Scout.
- Review is optional for direct work. When no separate reviewer is assigned,
  the owner can review the result. Do not invent a reviewer or make the agent
  approve its own work to satisfy the old schema.

## Implementation direction

Represent absent team ownership explicitly with an optional value. Keep direct
assignees separate from optional team context. Keep existing team identifiers on
historical work and explicitly assigned team workflows.

The workspace remains the scope for authorisation and billing. A missing team
does not mean missing attribution: usage still identifies the workspace, agent,
task or conversation, and existing cost classification. Team reports include
team-attributed work; workspace totals also include direct work, exactly once.

Direct assignees must resolve to valid agents in the current workspace. Removing
team membership as the validation mechanism must not allow callers to invent
personas, assign agents from another workspace, or spend against another task.
Validate those facts using canonical agent records and existing thread authority.

## Verified source constraints

Inspected integration commit: `c9eb3d6967855b3d8f2ef690757090798d61d857`.

- `crates/buzz-core/src/company.rs`: `CompanyTask` requires `owning_team_id`
  and `qa_persona_id`. `validate_task` also rejects assignees who are not members
  of any team. `AgentWorkContext` requires team attribution.
- `crates/buzz-sdk/src/implicit_task.rs`: `owning_team_for_chat` falls back to
  Company Coordination when membership is absent or ambiguous.
- `crates/buzz-relay/src/thread_task_broker.rs`: building a task first resolves
  a team; the requested persona is only kept as an assignee if it belongs to that
  selected team. This can lose the direct assignment as well as block the send.
- `crates/buzz-relay/src/company_broker.rs`: task heads emit required team tags.
- `crates/buzz-acp/src/work_context.rs`: a task reference without a team tag is
  rejected as incomplete. The runtime therefore needs the new contract too.
- `desktop/src/features/company/contracts.ts`: task parsing requires team and
  reviewer strings and checks the corresponding team tag.
- `desktop/src-tauri/src/commands/initiative.rs`: chat attachment seeds a
  coordination team; scoped first-job attachment also checks team readiness.
- `crates/buzz-core/src/ledger/attribution.rs`: attribution assignments currently
  require a team. Ledger parsing, aggregation, and correction paths need matching
  optional ownership support.

## Delivery sequence

1. Add optional ownership and review to the task and usage contracts, with legacy
   team-owned round-trip fixtures. Update canonical event tags and all readers
   together. No placeholder team IDs or empty-string substitutes.
2. Make relay attachment preserve explicit assignees independently of teams and
   validate them against current-workspace agent records. Keep retries idempotent
   and existing thread task attachment stable.
3. Update runtime task hydration, responder authority, work-reference tags, and
   accounting snapshots to accept direct work while refusing forged references.
4. Remove team provisioning/readiness as a prerequisite for direct chat in both
   desktop entry paths, preserving identity, workspace, and dispatch checks.
5. Update task display, ledger totals, filters, and owner review for direct work.
6. Run hosted integration checks and then verify the packaged desktop and relay
   together before claiming the original send failure resolved.

Protocol readers must accept the optional fields before writers emit direct work.
Deployment order must cover relay, runtime, and desktop compatibility; source
changes alone cannot establish that the installed app can send successfully.

## Acceptance evidence

- In a workspace with no team records, an authorised owner mentions a valid
  stand-alone agent. The exact message is accepted, that agent replies, and no
  team is created as a side effect.
- The task identifies the mentioned agent. Usage records identify that agent and
  task, and the matching Credits debit is reflected once in workspace totals.
- One-team and multiple-team membership do not redirect a direct mention or
  discard its assignee.
- Replying with New task off reuses an existing task where applicable; a retry
  after a lost receipt creates neither duplicate work nor duplicate charges.
- Existing team-directed work retains its correct team, leader, and review gate.
- An owner can review direct work without a team reviewer. Required explicit
  reviews on existing team workflows remain enforced.
- Unknown personas, agents from another workspace, forged task references, and
  unauthorised task participation remain rejected.
- A stale or unavailable team projection does not block a direct assignment.
  Genuine identity, relay, or billing failures retain clear error handling and
  preserve the draft for retry.
- Existing team-owned task/usage records still parse and retain their history;
  mixed direct/team report totals neither omit nor double-count work.

## Current proof state

Implementation is on `codex/standalone-agent-work`. Desktop contract regressions
were observed failing before the fix and passing afterward. Focused desktop tests
and type checking pass. Hosted Rust/integration validation and packaged/live
message, response, and Credits evidence remain required.
