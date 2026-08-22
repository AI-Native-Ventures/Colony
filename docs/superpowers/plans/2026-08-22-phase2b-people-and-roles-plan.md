# Phase 2b: the People and Roles screen (desktop)

Spec: `docs/superpowers/specs/2026-08-21-agent-org-and-visibility-design.html` section 3.6.

**Depends on phase 2a.** The relay must already accept the `manager` tag and kind
9046 before this is useful. Read 2a's plan and its commits first.

## Build on what v0.10.22 already shipped

`desktop/src/features/agents/employeeHeads.ts` already reads employee heads
(kind 30190) and exposes:

- `AgentRank` = `"worker" | "leader" | "executive"`
- `RANK_LABELS`: Worker, Team lead, Chief of staff
- `rankLabel`, `parseRank`, and the head query

`AgentRankBadge.tsx` renders it, and `ManagedAgentRow`, `UserProfilePanelFields`,
`UserProfilePopover`, `MembersSidebarMemberCard` and `ChannelScreenHeader` all
consume it.

Reuse every one of those. Do not introduce a second rank type, a second label map,
or a second badge.

**Never use the word "tier" in UI copy.** `employeeHeads.ts` says so explicitly and
the shipped product copy follows it. "Rank" in code, the `RANK_LABELS` strings in
anything a person reads.

## Task 1: extend the read layer with manager

- Add `manager: string | null` to `EmployeeHead`, parsed from the head's `manager`
  tag (see 2a).
- Add the equivalent read for managed-agent heads (kind 30177). Only heads
  authored by a community owner may be trusted, matching what the relay does at
  `crates/buzz-relay/src/interrupt_gate.rs:180-191`. A head an agent published
  about itself is ignored here exactly as the relay ignores it.
- Add `KIND_HIRE_REQUEST` and the employee-update kind from 2a to
  `desktop/src/shared/constants/kinds.ts`. `KIND_EMPLOYEE` is already there.

Tests: an owner-authored head's manager is read; a self-authored head's manager is
ignored; a malformed tag yields `null` rather than throwing.

## Task 2: the org tree builder

A pure function, its own file, with its own unit tests. No React.

Input: the agents with their rank and manager. Output: roots plus an unassigned
list.

Rules:

- Executives are roots. Several executives means several roots.
- An agent whose manager does not resolve (deleted, unknown, or an edge the relay
  would reject) is NOT dropped. It goes in `unassigned` so it stays visible.
- Workers and leaders with no manager go in `unassigned`.
- The builder must terminate on any input, including a manager cycle that should
  be impossible. Do not trust the invariant at render time; a hostile or corrupt
  head must not hang the UI.

Tests: multiple roots; an orphan; a manager pointing at a deleted agent; a
worker whose manager is itself unassigned; a cycle that must terminate; the empty
case.

## Task 3: the People and Roles screen

A new section reachable from Agents (`AgentsScreen.tsx` / `AgentsView.tsx` and
their sibling `*Section.tsx` files show the established pattern; `TeamsSection.tsx`
is the closest analogue).

- The tree: agents only, never humans. Each node shows avatar, name,
  `AgentRankBadge`, and live-or-idle state.
- Live state comes from the existing working signal
  (`useActiveWorkingChannelsById` / `agentWorkingSignal`). Do not invent a new
  liveness source.
- An "Unassigned" tray under the tree for everything the builder could not place.
- Empty state: a community with no ranked employees must say so plainly and point
  at hiring, not render a blank panel. This is exactly what the owner hit in
  v0.10.22.
- No drag-to-reassign. Reassignment happens in the edit dialog.

## Task 4: editing rank and manager

- Rank and manager pickers on the agent edit dialogs. Follow the field patterns in
  `AgentConfigFields.tsx` and the surrounding dialog files.
- The manager list contains only agents exactly one rank up. The UI narrows the
  choice; the relay still authorizes. Never rely on the picker as the guard.
- Executives get no manager picker.
- Surface the relay's own rejection message verbatim. Do not paraphrase it into
  friendlier copy: the relay's message names the rule that fired.

## Task 4b: promotion must state what it confers

**Read this before building the rank picker.** Delegation grants are not issued to
an agent. `ParsedGrant` (`crates/buzz-core/src/interrupt.rs:283`) has no holder
field, and `enforce_decision_log_authority`
(`crates/buzz-relay/src/interrupt_gate.rs:590`) authorizes a decision by checking
only that the signer is a Leader or Executive and that the cited grant is active,
matching category and within cap.

So a grant is a community-wide capability, and **promoting an agent to Team lead
hands it every active delegation in the community, immediately.**

The rank picker's confirmation must say so before the owner commits:

- List the active grants the promotion unlocks: category, scope and cap each,
  with a plain count when there are many.
- When there are none, say that too. "No delegations are currently active, so this
  grants no autonomous spending authority" is true and useful.
- Read grants with the same owner-authorship rule the relay uses (`active_grant`,
  `interrupt_gate.rs:506`, scans candidates because any author can publish a head
  at a `d` tag they do not own). A client that trusts the newest head will show a
  grant the relay would refuse.

Do not invent a per-agent permission model to make this read better. Describe the
system that exists. The full grants surface is phase 3; this is the one warning
that cannot wait for it, because the promote button ships here.

## Task 5: hiring in-app

- A hire form: role slug, display name, rank, optional manager. Publishes the hire
  request (kind 9045).
- The relay mints the keypair, so the head arrives asynchronously. Show a pending
  row that explains it is waiting for the workspace to mint an identity. A bare
  spinner with no explanation is not acceptable here.
- Promote, demote and reassign publish the 2a update kind.
- Role slug validation mirrors `is_valid_role_slug` in
  `crates/buzz-core/src/employee.rs`: lowercase, digits, `-` and `_`, starting
  alphanumeric, 64 characters maximum.

## Task 6: gates and evidence

```
. ./bin/activate-hermit
cd desktop && node --import ./test-loader.mjs --experimental-strip-types \\
  --test src/features/agents/<your test files>
just desktop-lint
```

**Do NOT run `just ci`.** It saturates the owner's machine for about ten minutes
and he is working on it. The full matrix runs on GitHub when the orchestrator
pushes.

Then capture screenshots, since this is a visual feature:

```
just desktop-screenshot --name org-chart --route <the new route>
```

Read the screenshot guidance in CLAUDE.md before you do. Two rules that catch
people: build with `pnpm build:e2e`, never `pnpm run build`; and scope each shot
with `locator.screenshot()` so two states do not come out byte-identical. Verify
distinctness with `shasum -a 256` before reporting.

Capture at least: a populated tree, a non-empty unassigned tray, and the empty
state.

## Definition of done

- Every test above passes, each proven to fail first.
- `just ci` passes.
- Screenshots captured, with distinct hashes.
- Nothing under `crates/` is touched. That was 2a.
- Every commit uses `git commit -s`.
- No PR, no merge. Commit and report back.

## Report back with

1. Failing-then-passing output for the tree builder tests and the owner-authorship
   test in Task 1.
2. The `just ci` result.
3. The screenshot paths and their hashes.
4. Anything in the existing rank read layer you had to change rather than extend,
   and why.
