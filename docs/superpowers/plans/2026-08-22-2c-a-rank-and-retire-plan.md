# 2c-A: make every agent rankable, and let the owner unhire

Scope: gaps 1, 2 and 8 from the phase 2b review. Nothing else. Other agents are
working the remaining gaps in parallel; staying inside these files is what keeps
that safe.

**Your files:** `EmployeeRoleDialog.tsx`, `managedAgentHeads.ts`, `orgMembers.ts`,
`PeopleSection.tsx` (empty state and a new unranked group only), and the agent
creation path. Do NOT touch navigation, the sidebar, the profile panel, the DM
header, the asks feature, or `OrgNodeCard`'s visual treatment.

## Task 1: personal agents must be rankable

This is the gap that started the whole project and phase 2b did not close it.

The org chart shows an agent only when its rank resolves: an employee row, or an
owner-authored kind 30177 head carrying `tier` (`resolveManagedAgentRank` in
`managedAgentHeads.ts`). **Nothing in the desktop app ever writes `tier`.** So
every personal agent the owner already has (Scout, Luke, Rivet, Anvil, Forager)
has no rank, never appears on the chart, and cannot be promoted. `orgMembers.ts`
line ~80 drops them: `if (!rank) continue`.

Deliver:

- `EmployeeRoleDialog` must handle BOTH kinds of agent. Employees change through
  kind 9046 as today. A personal agent changes by republishing its
  **owner-authored** kind 30177 head carrying `tier` and `manager`.
- Agent creation lets the owner set rank and manager up front.
- A personal agent with no rank still appears in the People section, in an
  **Unranked** group, with a one-click path to give it a rank. An agent visible in
  Settings but absent from the chart is the original bug wearing a new hat.
- Only owner-authored heads may ever be trusted, exactly as `agent_tier` does in
  `crates/buzz-relay/src/interrupt_gate.rs`. Kind 30177 is client-writable.
- The manager picker offers only agents exactly one rung up. The relay still
  authorizes; the UI only narrows.

Tests: an unranked personal agent appears in the Unranked group; ranking it moves
it onto the chart; a self-authored head is still ignored; the picker never offers
an illegal manager.

## Task 2: retire an employee from the app

The relay supports retirement through kind 9046 and refuses to retire a manager
that still has reports, naming them. The UI never exposes it, so hiring is a
one-way door.

- Retire in the Edit dialog, behind a confirmation that names the consequence.
- When the relay refuses because the target still has reports, surface its message
  verbatim and list those reports so the owner knows what to reassign first.
- A retired employee leaves the chart but stays discoverable. The record is never
  deleted and the UI must not imply otherwise.

Tests: retire succeeds for a leaf; retire is refused for a manager with reports
and the refusal names them.

## Task 8: fix the misleading empty state

It currently reads "No one is employed here yet" on a page listing five agents.
Both true; together they read as if the app forgot the agents.

After Task 1 this is mostly a routing problem: agents present but unranked is an
**action**, not an empty state. Reserve the empty state for genuinely nothing to
show, and make the unranked case say what it is.

## Gates

```
. ./bin/activate-hermit
cd desktop && node --import ./test-loader.mjs --experimental-strip-types \
  --test src/features/agents/<your test files>
just desktop-check
```

**Never `just ci`** (it saturates the owner's machine) and **never
`just desktop-lint`** (no such recipe).

Two repo rules that already broke this work once:
- No hand-rolled pubkey truncation; use `truncatePubkey` from `shared/lib/pubkey`.
- `native-inventory.json` records call-site line numbers; if you shift lines in a
  file it references, run `pnpm generate:native-inventory` and commit it.

## Done means

- Both tasks complete, tests proven failing first, `desktop-check` green.
- Screenshots: the Unranked group, the rank/manager editor on a personal agent,
  and the retire confirmation. Verify distinct hashes with `shasum -a 256`.
- `git commit -s` **after each task**, not all at the end. Two earlier agents in
  this series stalled with everything finished and nothing committed.
- No PR, no merge.
