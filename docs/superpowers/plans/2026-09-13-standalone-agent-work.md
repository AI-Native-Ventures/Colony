# Stand-alone Agent Work Implementation Plan

**Goal:** Directly mentioned agents can receive, perform, and account for work without any team membership.

**Architecture:** Use optional team and reviewer references on tasks and work attribution. Direct chat assigns the named workspace agent and preserves existing conversation context; explicit team workflows keep their current ownership and review requirements.

**Tech Stack:** Rust core/SDK/relay/ACP/native bridge, TypeScript desktop, Nostr canonical events.

## Contract and parser gate

- [x] Add regression coverage to the existing company repository and work-context tests: a signed task with `owningTeamId: null`, `qaPersonaId: null`, and no team tag parses; its outgoing message contains a task tag and no team tag. Run these tests on the original code and capture failures.
- [x] Change `CompanyTask`, `AgentWorkContext`, runtime `WorkReference`, and ledger `RuleAssignment` team fields to `Option<String>`; change task reviewer to `Option<String>`. Team workflow stages remain required strings. Preserve `Some` values in old fixtures.
- [x] Validate optional IDs; require an existing team/reviewer pool when explicitly supplied; stop using team membership as proof that a direct assignee exists. Keep duplicate/invalid-ID checks.
- [x] Update SDK/native/TypeScript parsers and relay task tags to match optional ownership exactly. Reject mismatched explicit team tags.

## Assignment and runtime gate

- [x] Remove implicit chat team selection. Keep the named persona as assignee, without a QA persona or team. Validate requested personas from canonical managed-agent heads in the current community before attaching work.
- [x] Preserve existing thread task attachment/idempotency. Keep agent subtask and completion authority checks.
- [x] Stop native direct-chat attachment from creating or requiring a coordination team; retain identity, owner, relay, and dispatch binding checks.
- [x] Accept a task work reference without a team in ACP; compare optional references with canonical content, and retain direct work attribution instead of guessing from team membership.
- [x] Keep team-directed task planners explicit and compatible. Allow user-created workspace tasks without a default coordination team.

## Accounting and presentation gate

- [x] Update ledger parsing/corrections/totals for optional team attribution; workspace totals retain direct work.
- [x] Display agent/direct-work ownership without fake team identifiers; optional reviewer uses owner review.
- [x] Run focused desktop tests and type checks. Add Rust contract/SDK/relay regression cases for no-team direct work and old team workflows.

## Integration gate

- [ ] Review changed call sites and run formatting. Use hosted CI for Rust compilation and integration checks.
- [ ] Commit with DCO, publish a PR targeting develop, and arm the required merge queue only when its integration evidence is ready for review.
- [ ] Report source, test, CI, merge, and installed/live proof separately. A packaged desktop message, agent reply, and matching usage debit are required before calling the user-visible issue resolved.
