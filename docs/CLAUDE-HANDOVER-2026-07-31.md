# Claude Handover — Colony Company Operating System

**Date:** 2026-07-31  
**Repository:** `/Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/chat-native-blocks-plan`  
**Branch:** `codex/chat-native-blocks-plan`  
**Draft PR:** https://github.com/nocodeafrica/AI-Native-Ventures-App/pull/1  
**Handover state:** three reviewed implementation commits plus this signed
handover commit are local and not yet pushed; Task 7 is implemented and
focused-green but uncommitted.

## 1. Mission

Complete the approved Colony company operating system implementation without
turning it into a page-heavy SaaS product.

Colony is a chat-first operating environment for a person or team to run a
digital or service business. Agents are employees who do real work. The primary
interaction is conversation with agents. Rich structured experiences appear
inline in chat as Blocks; dense dedicated surfaces are reserved for workflows
that genuinely need them, particularly Lead Discovery and Outreach.

Do not stop after routine internal proof gates. Continue autonomously through
the approved plans until a genuine product decision, external dependency, or
material blocker requires the user.

## 2. Read these first

1. `AGENTS.md`
2. `docs/superpowers/specs/2026-07-31-colony-company-operating-system-design.md`
3. `docs/superpowers/plans/2026-07-31-colony-company-os-roadmap.md`
4. `docs/superpowers/plans/2026-07-31-colony-company-operating-kernel.md`
5. `docs/superpowers/plans/2026-07-31-colony-chief-of-staff-onboarding.md`
6. `docs/superpowers/plans/2026-07-30-chat-native-blocks-foundation.md`
7. `docs/superpowers/plans/2026-07-31-owned-relay-company-bootstrap.md`

The Phase 1A kernel plan and design spec were corrected during implementation.
Treat the current files on this branch as authoritative, not older chat notes.

## 3. Locked product decisions

- Product name: **Colony**.
- Public location: `colony.ainative.ventures/app`; the landing page is being
  handled separately.
- Consumer-facing branding can change now; internal Buzz names can remain until
  later. Do not spend time on a wholesale technical rename.
- Chat is the primary product primitive.
- Structured Blocks render inline in threads and remain persistent/referenceable.
- Do not add Company, Initiative, Task, accounting, or department pages.
- Dense dedicated UI is justified for Lead Discovery and Outreach only.
- Leads, clients, plugins, agents, teams, initiatives, tasks, and Blocks must be
  referenceable from chat.
- Every Task has exactly one owning team.
- Cross-team work is an Initiative containing multiple single-team Tasks.
- One Persona can belong to multiple teams.
- Team leads delegate and perform QA; `@team` means all members.
- Personal name and stable role identity are separate. Both may be used for
  mentions while the authoritative target remains a pubkey/persona ID.
- The fixed baseline roster is customizable. Only the Chief of Staff is
  provisioned initially; the remaining roster starts as Persona definitions and
  is lazily provisioned.
- No generic Operations team. Service/production teams are generated after the
  website scan and Chief of Staff interview.
- Cost classification is deterministic, never inferred by an LLM:
  - client delivery with a client organization -> COGS;
  - sales, marketing, administration, internal product -> OPEX;
  - uncertain or client delivery without a client -> needs review.
- Discovery must reach SalesTeams UI/flow parity before Colony-specific design
  changes.
- Outreach is a first-class multichannel primitive using a shared core plus
  channel adapters.

## 4. Fixed baseline roster

1. Chief of Staff
2. Website Agent
3. CTO
4. Frontend Engineer
5. Backend Engineer
6. Security Engineer
7. DevOps Engineer
8. Marketing Lead
9. Content & Campaign Specialist
10. Lead Specialist
11. Sales Lead
12. Outreach & Closing Specialist
13. CFO

Fizz keeps the stable identity `builtin:fizz` and personal display name `Fizz`,
but now has the stable role `chief-of-staff` / `Chief of Staff`.

## 5. Critical architecture correction

The original plan made Company, Initiative, and Task NIP-33 heads directly
authored by the current human owner. That is unsafe: the author pubkey is part
of a NIP-33 coordinate, so transferring community ownership creates competing
heads. A pre-insert owner check also races ownership transfer.

The corrected model is committed and documented:

- `30179` — relay-authored Company head.
- `30180` — relay-authored Initiative head.
- `30181` — relay-authored Task head.
- `40013` — owner-signed Company Action command.
- `40014` — relay-signed Company Receipt.
- The stable signer is `AppState.relay_keypair`, configured by
  `BUZZ_RELAY_PRIVATE_KEY` and advertised as NIP-11 `self`.
- Clients build/sign Company Actions. They never directly construct or publish
  canonical heads or receipts.
- The relay broker authenticates and locks the current human owner inside the
  same database transaction used to validate CAS references and write the
  action, head, idempotency claim, and receipt.
- Direct submissions of `30179`–`30181` and `40014` are relay-only and must be
  rejected.
- Relay key rotation must eventually re-sign current heads before switching
  keys. Do not silently generate a new key for a live community.

### Company Action public tags

Keep metadata minimal and exact:

1. one `p` tag for the relay pubkey;
2. one `a` tag for the target relay-authored coordinate;
3. one `company-action` tuple containing version, operation, request UUID, and
   idempotency UUID;
4. no `h` tag and no duplicate scalar metadata tags.

Canonical content mirrors the operation, IDs, target, expected head,
expected reference heads, and complete typed payload. The SDK cross-checks all
tag/content fields.

### Receipt public tags

1. one `p` tag for the requester/actor;
2. one marked `e` link to the action;
3. one `a` target coordinate;
4. one exact `company-receipt` tuple;
5. no extra public context.

An applied receipt must include the exact resulting head event ID in strict
canonical receipt content.

## 6. Git and PR state

### Remote state

`origin/codex/chat-native-blocks-plan` currently points to:

```text
ae72725882d6ea34ed8c8b7f167333cf9b6734e9
```

### Last implementation commit before this handover commit

```text
3f4de5d612d17351cfadd3889977b10e3db5af82
```

After committing this document separately, the branch is **ahead of origin by
four commits**:

```text
09bdbebbd fix(core): stabilize Colony company authority
aaf9caf76 feat(sdk): build Colony company actions
3f4de5d61 feat(agents): separate employee name from role
(documentation-only) docs: add Claude Colony handover
```

The three implementation commits are DCO signed and independently reviewed.
The handover commit is documentation-only and DCO signed. Do not rewrite or
drop them.

Earlier committed foundation:

```text
ae7272588 feat(core): add Colony company work contracts
b6529c8a3 test(core): pin Colony company work contracts
9f2635e7d docs: plan Colony company foundation
db6175ec6 docs: define Colony company operating system
3c1f4e93c docs: correct owned relay operator commands
```

The draft PR already exists. Pushing this branch updates it automatically.

### GitHub authentication

Push access has required temporarily switching the active GitHub CLI account:

```bash
gh auth switch -u nocodeafrica
git push origin codex/chat-native-blocks-plan
gh auth switch -u it-anastellar
```

Always restore `it-anastellar` afterward.

## 7. Proven committed work

### Core company/work contracts

Implemented in `buzz-core`:

- strict Company, Initiative, Task, service, cost centre, team reference, and
  encrypted AgentWorkContext schemas;
- `deny_unknown_fields` on externally parsed objects;
- bounded IDs/text/collections and finite non-negative expected costs;
- deterministic cost classification;
- cross-record company/cost-centre/team/QA/assignee validation;
- backward-compatible optional `workContext` on NIP-AM turn metrics;
- exhaustive lifecycle transition helpers;
- immutable IDs/company coordinates/`createdAt` on replacement;
- strictly increasing `updatedAt`;
- relay authority kinds and classifications.

Proof recorded before commit:

- full `buzz-core`: 273 tests plus 2 doc tests passed;
- core Clippy with warnings denied passed;
- independent review passed.

### SDK Company Actions

Implemented in `buzz-sdk`:

- public owner-signable `build_company_action`;
- strict parsing for Company Actions, Company/Initiative/Task heads, and
  Company Receipts;
- no public client builders for heads or receipts;
- exact minimal tag cardinality and canonical JSON;
- create vs replacement expected-head rules;
- strict expected-reference coordinates/event IDs;
- self-head CAS is allowed only through `expectedHead`, never duplicated in
  expected references;
- nested unknown fields rejected;
- applied receipts require exact resulting head event ID.

Proof recorded before commit:

- focused SDK tests: 8 passed;
- full SDK tests: 261 passed;
- Clippy with warnings denied, formatting, and diff checks passed;
- independent review passed after three findings were fixed.

### Persona role identity

Implemented in desktop/Tauri/TypeScript:

- optional paired `role_id` / `role_title` across definitions, stored unified
  records, Persona events, create/update/inbound requests, API mappings, catalog
  projection, and E2E mock bridge;
- absent update fields preserve role identity for older callers;
- role validation uses lowercase stable slugs and nonblank trimmed titles;
- role changes participate in Persona content hashing/source version;
- role metadata survives the `save_personas()` fold into the unified managed
  agent store;
- roles never overwrite Persona display names or deployed agent personal names;
- Fizz migration upgrades only the exact legacy maker prompt and preserves
  customized prompts;
- Fizz remains `builtin:fizz` / `Fizz` and gains the Chief of Staff role/prompt;
- secrets remain excluded from Persona projections.

The desktop file-size ratchet was repaired rather than bypassed:

- Rust backend types were split into
  `desktop/src-tauri/src/managed_agents/types/backend_types.rs`;
- Persona-facing TS contracts moved to
  `desktop/src/shared/api/personaTypes.ts` with compatibility re-exports;
- all legacy oversized files were reduced to their allowed baselines.

Proof recorded before commit:

- Rust Persona tests: 26 passed;
- Persona event tests: 28 passed;
- TS catalog/sync tests: 28 passed;
- typecheck, file-size ratchet, formatting, and focused Biome passed;
- independent review passed.

## 8. Current uncommitted work — Task 7 Team leads

Task 7 is implementation-complete and focused-green, but deliberately
uncommitted and unpushed. There are no running processes.

### Implemented behavior

- durable optional `TeamRecord.lead_persona_id`;
- legacy stored JSON without a lead parses as `None`;
- tri-state update semantics:
  - absent -> preserve;
  - `null` -> clear;
  - string -> set;
- matching tri-state Team event projection;
- lead must be included in `persona_ids`;
- duplicate Persona IDs inside one team are rejected;
- the same Persona may belong to multiple teams;
- create/update validate the complete proposed state before mutation;
- inbound reconciliation validates the complete resulting state;
- Persona deletion and built-in deactivation check both member and lead
  references;
- Team dialog edits preserve an existing lead; duplication copies it;
- `ManagedAgentRecord.team_id` is documented as a deployment/runtime hint, not
  exclusive membership or Task ownership;
- directory-backed Team deletion blocks when sourced Personas remain
  member/lead of another Team or are referenced by managed-agent instances;
- Team snapshot v1 imports set lead to `None`; portable lead mapping is deferred
  until the snapshot schema can identify a remappable member rather than copying
  a source Persona ID;
- TypeScript validation/mapping and mock bridge mirror native semantics.

### Changed tracked files

```text
desktop/src-tauri/src/commands/personas/inbound.rs
desktop/src-tauri/src/commands/personas/inbound/inbound_tests.rs
desktop/src-tauri/src/commands/personas/mod.rs
desktop/src-tauri/src/commands/team_snapshot.rs
desktop/src-tauri/src/commands/team_snapshot/tests.rs
desktop/src-tauri/src/commands/teams.rs
desktop/src-tauri/src/managed_agents/team_events.rs
desktop/src-tauri/src/managed_agents/team_repair.rs
desktop/src-tauri/src/managed_agents/team_snapshot.rs
desktop/src-tauri/src/managed_agents/teams.rs
desktop/src-tauri/src/managed_agents/teams_tests.rs
desktop/src-tauri/src/managed_agents/types.rs
desktop/src-tauri/src/managed_agents/types/requests.rs
desktop/src/features/agents/lib/teamPersonas.ts
desktop/src/features/agents/teamHooks.ts
desktop/src/features/agents/ui/TeamDialog.tsx
desktop/src/features/agents/ui/useTeamActions.ts
desktop/src/shared/api/tauriTeams.ts
desktop/src/shared/api/types.ts
desktop/src/testing/e2eBridge.ts
desktop/tests/helpers/bridge.ts
```

### New untracked implementation file

```text
desktop/src/features/agents/lib/teamLead.test.mjs
```

### Focused proof already green

- desktop Tauri `cargo check`;
- Team tests: 28 passed;
- Team event tests: 14 passed;
- inbound reconciliation tests: 19 passed;
- TS Team lead/persona tests: 8 passed;
- `pnpm typecheck`;
- `pnpm lint` — exit 0, only two unrelated informational suggestions;
- `pnpm check:file-sizes`;
- desktop Cargo formatting check;
- `git diff --check`.

### Remaining Task 7 proof

- full desktop Rust suite;
- desktop Clippy;
- full desktop `pnpm test`;
- full `pnpm check` including px-text and pubkey guards;
- smoke E2E;
- independent review of the final Task 7 diff;
- commit and push.

### Important Task 7 review question

Inbound validation refuses invalid local Team state, but the existing
reconciliation architecture retains the winning relay event before applying its
projection. An invalid winning Team event can therefore enter retention and
then fail local projection. Decide whether to validate Team content before
retention in this task or explicitly preserve the existing model where the
remote head is retained but invalid local state is refused.

Do not casually reorder this path: it is a relay/local-authority semantic
decision and needs tests.

## 9. Exact current dirty-tree boundary

The only intended product changes in the dirty tree are the Task 7 files listed
above plus the new `teamLead.test.mjs`. This handover document is tracked in its
own documentation commit.

The following pre-existing support directories are untracked and must never be
committed:

```text
.codegraph/
.superpowers/
```

Before any commit, compare `git status --short` to this document.

## 10. Immediate continuation sequence

### Step A — finish and commit Task 7

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/chat-native-blocks-plan
. ./bin/activate-hermit

cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-fail-fast
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml --all-targets -- -D warnings

cd desktop
node --import ./test-loader.mjs --experimental-strip-types --test \
  src/features/agents/lib/teamLead.test.mjs \
  src/features/agents/lib/teamPersonas.test.mjs
pnpm test
pnpm typecheck
pnpm check

cd ..
git diff --check
git diff
```

Run an independent review of only the Task 7 paths. If clean, stage the exact
files listed in section 8 plus `teamLead.test.mjs` and commit with DCO:

```bash
git commit -s -m "feat(teams): add lead identity and multi-team invariants"
```

Do not amend the handover commit into the Task 7 feature commit.

### Step B — implement Task 8 role-aware mentions

The read-only reconnaissance is complete. The written plan misses several
files; inspect actual code before editing.

Actual pipeline:

1. `useMentions.ts` joins managed agents, Personas, and Teams;
2. `mentionRanking.ts` ranks labels;
3. `mentionSuggestionMapping.ts` maps suggestions;
4. `MentionAutocomplete.tsx` renders;
5. `insertMention` stores text-to-pubkey/persona references;
6. `useMentionSendFlow.ts` provisions/starts/dedupes targets and publishes
   authoritative pubkeys.

Files additionally required beyond the plan:

- `desktop/src/features/messages/lib/flushMentionDebounce.ts`;
- its tests;
- `desktop/tests/helpers/bridge.ts`;
- `desktop/src/testing/e2eBridge.ts` role seeds.

Critical invariant: if a role match inserts visible `@CTO`, the authoritative
mention maps must also be keyed by `CTO`, not `Jason`. Otherwise the UI shows
the role mention while send silently loses the target.

Candidate/suggestion fields should include:

```ts
roleId?: string | null;
roleTitle?: string | null;
insertLabel?: string;
matchLabels?: string[];
```

Ranking must report which alias won:

- personal/persona match -> insert the personal display name;
- role ID/title match -> insert the role title;
- pubkey/persona ID remains authoritative.

Team expansion must dedupe in stable order by pubkey, then Persona ID, while
preserving the existing duplicate-display-name safety check.

Known limitation: the current text-keyed editor cannot represent two different
entities with the exact same visible mention token in one draft. Do not claim
per-occurrence disambiguation. Explicit autocomplete selection may establish
one authoritative target for a token; a future rich mention-node editor is the
real fix.

The correct E2E project is `smoke`, not `integration`:

```bash
cd desktop
pnpm test:e2e:smoke -- --grep "role mention"
```

### Step C — push the accumulated reviewed commits

After Task 7 and Task 8 are committed and pre-push is expected to pass:

```bash
gh auth switch -u nocodeafrica
git push origin codex/chat-native-blocks-plan
gh auth switch -u it-anastellar
```

The pre-push hook is substantial. Let it finish; it previously passed full Rust
unit suites and 1,894 desktop tests on the earlier gate.

### Step D — implement the relay broker

Only start after Persona roles, Team leads, and role/team mention prerequisites
are green as required by the corrected plan.

Follow the existing Block broker architecture, but preserve these additional
invariants:

- use `AppState.relay_keypair` and require a configured durable relay key;
- Company Action requires `UsersWrite` and is global-only;
- heads/receipt are relay-only;
- no Company kinds require `h`;
- current human owner check occurs inside the same DB transaction as the
  mutation;
- serialize against ownership transfer by locking the owner membership row;
- claim idempotency per community;
- verify expected head and expected reference event IDs;
- load real Company/Initiative/Team heads and validate the complete record;
- enforce transition/replacement helpers from `buzz-core`;
- atomically insert action, relay-authored head, receipt, and idempotency result;
- stale conflicts never partially store/replace;
- duplicate idempotency returns the original result;
- old-owner requests queued before a transfer must fail after the transfer.

Search/FTS warning: fresh databases use a positive allowlist, so a naive
integration test may pass without proving a brownfield upgrade. Add a `0029`
migration that wraps existing `search_tsv` expressions and explicitly nulls
`30179`, `30180`, `30181`, `40013`, and `40014`. PostgreSQL tests must run with
`--include-ignored`; otherwise zero relevant tests may execute.

### Step E — continue Phase 1A

After broker proof:

1. CLI Company/Initiative/Task reads and action-based writes;
2. desktop relay repositories for canonical heads/receipts;
3. chat Task/Initiative/Team context tags;
4. idempotent implicit Task action -> receipt -> head before agent start;
5. ACP hydration/refusal when paid-turn context is absent;
6. encrypted NIP-AM work attribution;
7. full local relay/desktop proof.

### Step F — implement Phase 1B Chief of Staff onboarding

Preserve the existing identity/community onboarding. Then:

1. provision only Fizz/Chief of Staff in Welcome;
2. perform an SSRF-safe bounded website scan;
3. produce a sourced Company Brief Block;
4. ask one gap-filling question per Interview Block;
5. produce a Blueprint Block and persistent review surface;
6. on approval, materialize Company, roster Persona definitions, Teams, cost
   centres, and three proposed Initiatives idempotently;
7. do not auto-run the proposed work;
8. lazily provision non-Chief-of-Staff agents when mentioned.

## 11. Quality and workflow rules Claude must preserve

- Activate Hermit before Git, hooks, Rust, Node, or desktop commands:

  ```bash
  . ./bin/activate-hermit
  ```

- Every commit uses `git commit -s`.
- Never commit `.codegraph/` or `.superpowers/`.
- Use Codegraph before editing when available; its index is already initialized
  in the worktree.
- No production `unwrap()` or `expect()`.
- Public Rust APIs require doc comments.
- New readable text uses named rem-based Tailwind tokens, never arbitrary px or
  rem sizes.
- Do not increase file-size ratchet limits. Split files instead.
- Desktop is outside the root Cargo workspace. Use its manifest explicitly.
- Worktree desktop formatting can be tricky; use the project command/hook and
  verify the actual diff afterward.
- Desktop browser proof requires the E2E mock bridge and `pnpm build:e2e` or the
  supplied E2E scripts. A plain Vite build produces misleading “Community
  connection failed” failures.
- Kill stale port 4173 before rebuilding E2E when necessary.
- For UI screenshot proof, wait for animations and use scoped captures; do not
  post duplicate screenshots.
- `tsx` is not installed as a workspace binary. Prefer the repository Node
  loader:

  ```bash
  node --import ./test-loader.mjs --experimental-strip-types --test ...
  ```

  `pnpm dlx tsx` also worked, but the repository loader is preferable.

## 12. Proven versus unproven

### Proven

- Core contracts and corrected stable authority model.
- SDK owner-signed Company Actions and strict read-only parsers.
- Persona role durability, Fizz Chief of Staff migration, name/role separation.
- Task 7 Team lead focused implementation and focused tests.
- Three local DCO commits reviewed and green.

### Not yet proven

- Task 7 full desktop suite, Clippy, full JS checks, E2E, and final review.
- Role-aware mention behavior and E2E.
- Relay Company broker or DB migration.
- Live PostgreSQL/Redis broker behavior.
- CLI action-based writes.
- Implicit Task creation before paid turns.
- Real paid-turn NIP-AM attribution through ACP.
- Chief of Staff website-scan/interview/blueprint onboarding.
- Packaged desktop artifact.
- Deployment or live production behavior.

Do not describe the overall product as complete until these are implemented and
proved through their actual user-facing/runtime paths.

## 13. Final handover checklist

- [ ] Read the current corrected spec and plan.
- [ ] Confirm Git status matches sections 8 and 9.
- [ ] Preserve the four local commits ahead of origin, including this handover.
- [ ] Finish/review/commit Task 7.
- [ ] Implement/review/commit Task 8.
- [ ] Push and update draft PR #1.
- [ ] Build the relay broker with transactional owner/idempotency guarantees.
- [ ] Continue Phase 1A without pausing at routine gates.
- [ ] Implement Phase 1B onboarding.
- [ ] Keep chat primary and avoid adding unnecessary pages.
