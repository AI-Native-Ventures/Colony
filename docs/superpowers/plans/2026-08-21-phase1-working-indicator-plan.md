# Phase 1 (part A): per-agent elapsed time in channel activity

Spec: `docs/superpowers/specs/2026-08-21-agent-org-and-visibility-design.html` section 2.1.

Scope of this plan: **bug #7 only**. The liveness probe (bug #8, spec section 2.2)
is being run separately by the orchestrator and is NOT part of this work. Do not
touch `REMOVE_AFTER_MS`, `LIVENESS_INTERVAL_MS`, or anything in `crates/buzz-acp`.

## The bug

Hovering a channel with two working agents shows the same elapsed time on every
row, because every row renders the channel's oldest turn rather than each agent's
own start.

- `ActiveChannelTurnSummary` carries one `anchorAt` per channel, computed as the
  minimum across every agent's live turns
  (`desktop/src/features/agents/activeAgentTurnsStore.ts`, `getActiveTurnsByChannel`).
- `WorkingAgentRows` computes `elapsed` once from that value and passes the same
  string into every row
  (`desktop/src/features/sidebar/ui/ChannelActivityPopover.tsx:199`).

Per-agent start data is already correct in the store: each turn has `startedAt`,
and `clockOffsetByAgent` holds the per-agent skew correction. The information is
lost only in the channel-level aggregate.

## Task 1: failing tests first

Add to `desktop/src/features/agents/activeAgentTurnsStore.test.mjs`:

1. Two agents start turns in the same channel 40s apart. Assert
   `getActiveTurnsByChannel()` returns two distinct per-agent anchors, and that
   the difference between them is 40s.
2. Same case: assert `anchorAt` still equals the minimum of the per-agent anchors.
   The collapsed sidebar badge must not change behaviour.
3. One agent with two live turns in one channel anchors to its own earliest turn.
4. `agentPubkeys` and the new per-agent anchor array are the same length and are
   index-aligned after the existing sort.
5. Per-agent clock offsets are applied per agent: two agents with different
   offsets and identical raw `startedAt` produce different anchors.

**Run these against the unmodified store and confirm every one fails.** Paste the
failing output into the PR body. A test that passes before the fix is not testing
the fix.

## Task 2: carry per-agent anchors through the store

In `activeAgentTurnsStore.ts`:

```ts
export type ActiveChannelTurnSummary = {
  channelId: string;
  anchorAt: number;          // unchanged: earliest live turn in the channel
  agentCount: number;
  agentPubkeys: string[];
  agentNames?: string[];
  agentAnchorsAt: number[];  // NEW: index-aligned with agentPubkeys
};
```

In `getActiveTurnsByChannel`:

- Accumulate a per-agent earliest anchor per channel, not just a channel minimum.
  The current accumulator uses `agentPubkeys: Set<string>`; replace it with a
  `Map<string, number>` from agent key to that agent's earliest anchor in this
  channel.
- Derive `agentPubkeys` from the map's sorted keys, exactly as today, and build
  `agentAnchorsAt` from the same sorted order in one pass so the arrays cannot
  drift apart.
- `anchorAt` stays the minimum across the map's values.
- `agentCount` stays the map size.

Constraints:

- `agentAnchorsAt` is built in the store and is ALWAYS aligned with
  `agentPubkeys`. Do not build it anywhere a filter could drop entries.
  `resolveActiveWorkingChannelNames` in
  `desktop/src/features/sidebar/lib/useActiveWorkingChannelsById.ts` uses
  `flatMap` and can produce a SHORTER `agentNames`; that is why the popover has an
  alignment guard. Do not copy that pattern.
- `cachedChannelTurnSummaries` memoization stays as it is. Do not weaken it.
- Do not change `ActiveTurnSummary` or `getActiveTurnsForAgent`.

## Task 3: render per-row elapsed

In `desktop/src/features/sidebar/ui/ChannelActivityPopover.tsx`, `WorkingAgentRows`:

- Compute elapsed per row from `activeWorking.agentAnchorsAt[index]`.
- Keep the single `useNow(1000)` tick for the whole list. Do not add a timer per
  row.
- Fall back to `activeWorking.anchorAt` when `agentAnchorsAt` is missing or its
  length does not match `agentPubkeys`, mirroring the existing
  `alignedAgentNames` guard. Never render an empty or `NaN` duration.

`SidebarSection.tsx:111` reads `summary.agentNames?.[0]` and the collapsed badge
reads `anchorAt`. Both keep working unchanged; verify you have not altered them.

## Task 4: gates

Run from the worktree root, after `. ./bin/activate-hermit`:

```
cd desktop && pnpm test:unit          # or the repo's unit-test task for desktop
just desktop-lint
just ci
```

`just ci` is the full local gate and must pass before you report done.

## Definition of done

- All five tests from Task 1 pass, and you have the earlier failing output saved.
- `just ci` passes.
- No changes outside these three files plus the test file:
  - `desktop/src/features/agents/activeAgentTurnsStore.ts`
  - `desktop/src/features/agents/activeAgentTurnsStore.test.mjs`
  - `desktop/src/features/sidebar/ui/ChannelActivityPopover.tsx`
- Every commit uses `git commit -s` (DCO is a required check).
- Do NOT open a PR and do NOT merge anything. Commit to the current branch and
  report back. The orchestrator reviews, verifies in the running app, and handles
  the PR.

## Report back with

1. The failing test output from before the fix.
2. The passing output after.
3. The `just ci` result.
4. Anything in the store that surprised you, especially around clock offsets or
   the summary cache.
