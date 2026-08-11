# Channel Workspace Phase B2 Implementation Plan: desktop surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tab ownership visible and operable in the desktop app: every tab
shows who is driving it, a human can hand a tab to an agent and take it back,
the channel shows that an agent is working without ever hijacking the content
column, and typing into a tab an agent is driving takes it back rather than
fighting the agent for the cursor.

**Architecture:** Phase A's local tab store stays the source of truth for tab
existence, order and payload. B1's relay events are the source of truth for
**ownership only**. A second module store mirrors owner and driver per tab,
hydrated from relay tab-head events and reset on community switch. The tab strip
and workspace shell read that store; nothing in this plan reads or publishes a
tab's `payload`.

**Tech Stack:** React 19, TypeScript, Tailwind, `lucide-react`, `node --test`
for unit tests, Playwright for the E2E spec. No Rust.

## Global Constraints

- **Depends on Phase B1.** `KIND_WORKSPACE_TAB_HEAD` (30192),
  `KIND_WORKSPACE_TAB_GRANT` (44400) and `KIND_WORKSPACE_TAB_TAKEOVER` (44401)
  must exist on the relay before Task 5 can be proven against one. Tasks 1 to 4
  are pure and can be written first.
- **Never hijack the content column.** An agent starting work does **not** flip
  a channel into workspace mode. The header button gains an indicator and the
  channel list gains a badge. Entering workspace mode stays a human act. This is
  a spec rule, not a preference: taking over the whole content column while
  someone is reading is far more disruptive than a side panel, and the surface
  being replaced is the conversation itself.
- **The workspace layer still never reads `payload`.** Ownership is
  workspace-level; payload stays the kind's business.
- No `text-[13px]`-style literals, px or rem. Rem tokens only (`text-base`,
  `text-sm`, `text-xs`, `text-2xs`, `text-3xs`). `pnpm check:px-text` fails the
  build on either.
- No `@tauri-apps/*` imports outside `src/shared/api/tauriNativeBridge.ts`.
  `pnpm check:native-bridge-boundary` fails otherwise. Use `invoke` from
  `@/shared/api/nativeBridge` if you need a native call, though this plan needs
  none.
- **Every new module-level store must be reset** in `resetCommunityState()`
  (`desktop/src/features/communities/useCommunityInit.ts`). Task 9 does this.
- 1000-line ceiling per file. `ChannelPane.tsx` is at **996** after Phase A, so
  it has 4 lines of headroom. Do not put anything there; if a change seems to
  need it, put it in a new file.
- `cn` is imported from `@/shared/lib/cn`, not `@/shared/lib/utils`.
- Function components only. No class components.
- Commit with `git commit -s` every time.
- Scoped unit test command (`pnpm test -- <path>` does **not** scope in this
  repo, it expands to the whole 4300-test suite):
  `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test <path>`
- If `pnpm check` fails on `native-inventory.mjs --check`, that is not Biome:
  the inventory records native **callsite line numbers**, so any edit shifting
  lines in a file containing an `invoke(...)` call makes it stale. Run
  `pnpm generate:native-inventory` and commit the result.

## Out of scope for B2

| Deferred | Why | Lands in |
| --- | --- | --- |
| Approval cards, thread mirror, allow-once/always | Its own security surface | Phase B3 |
| Evidence posting and ledger wiring | Same | Phase B3 |
| Live agent representation (cursor, highlighted target, action chip) | Defined per kind; the three shipping kinds have no remote-driven view yet | Phase D with `web` |
| Background toggle and the 3-session cap | Needs a session manager, not just ownership | Phase B3 |
| Per-kind payload sync | Only portable payloads can sync; a path cannot | When a portable kind needs it |
| `web`, `terminal`, `video` kinds | Unchanged | Phases C and D |

## File structure

| File | Responsibility |
| --- | --- |
| `desktop/src/features/workspace/lib/tabOwnership.ts` | Per-tab owner/driver store, hydrated from the relay |
| `desktop/src/features/workspace/lib/tabOwnership.test.mjs` | Its tests |
| `desktop/src/features/workspace/lib/ownershipDecisions.ts` | Pure rules: who may act, what the UI should say |
| `desktop/src/features/workspace/lib/ownershipDecisions.test.mjs` | Its tests |
| `desktop/src/features/workspace/lib/tabOwnershipEvents.ts` | Build head/grant/takeover events, publish them |
| `desktop/src/features/workspace/lib/tabOwnershipEvents.test.mjs` | Its tests |
| `desktop/src/features/workspace/lib/useTabOwnershipSync.ts` | Subscribe a channel's tab heads into the store |
| `desktop/src/features/workspace/ui/TabDriverBadge.tsx` | Who is driving, on a tab |
| `desktop/src/features/workspace/ui/DriverBanner.tsx` | "Agent X is driving" plus Take over |
| `desktop/tests/e2e/workspace-ownership.spec.ts` | E2E screenshot spec |

Modified:

| File | Change |
| --- | --- |
| `desktop/src/shared/constants/kinds.ts` | The three B1 kind integers |
| `desktop/src/features/workspace/ui/WorkspaceTabStrip.tsx` | Driver badge per tab |
| `desktop/src/features/workspace/ui/ChannelWorkspace.tsx` | Driver banner, sync hook |
| `desktop/src/features/workspace/kinds/scratchpadKind.tsx` | Typing takes the tab back |
| `desktop/src/features/channels/ui/ChannelScreenHeader.tsx` | Agent-working dot on the toggle |
| `desktop/src/features/communities/useCommunityInit.ts` | Reset the new store |
| `desktop/playwright.config.ts` | Register the new spec in `smoke` |

---

## Task 1: Kind constants

**Files:**
- Modify: `desktop/src/shared/constants/kinds.ts`
- Test: `desktop/src/shared/constants/workspaceKinds.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `KIND_WORKSPACE_TAB_HEAD = 30192`, `KIND_WORKSPACE_TAB_GRANT = 44400`,
  `KIND_WORKSPACE_TAB_TAKEOVER = 44401`.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/shared/constants/workspaceKinds.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

const kinds = await import("./kinds.ts");

test("workspace ownership kinds match the relay's integers", () => {
  // These MUST equal crates/buzz-core/src/kind.rs. A drift here is silent:
  // events publish fine and simply never match a subscription.
  assert.equal(kinds.KIND_WORKSPACE_TAB_HEAD, 30192);
  assert.equal(kinds.KIND_WORKSPACE_TAB_GRANT, 44400);
  assert.equal(kinds.KIND_WORKSPACE_TAB_TAKEOVER, 44401);
});

test("the head is addressable and the audit kinds are not", () => {
  const addressable = (kind) => kind >= 30000 && kind <= 39999;
  assert.equal(addressable(kinds.KIND_WORKSPACE_TAB_HEAD), true);
  assert.equal(addressable(kinds.KIND_WORKSPACE_TAB_GRANT), false);
  assert.equal(addressable(kinds.KIND_WORKSPACE_TAB_TAKEOVER), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd desktop && node --import ./test-loader.mjs --experimental-strip-types --test src/shared/constants/workspaceKinds.test.mjs`

Expected: FAIL, `expected undefined to equal 30192`.

- [ ] **Step 3: Write the implementation**

Add to `desktop/src/shared/constants/kinds.ts`, keeping the file's existing
grouping and comment style:

```typescript
/** Channel workspace tab head (addressable, `d` = tab id). Ownership only. */
export const KIND_WORKSPACE_TAB_HEAD = 30192;
/** A tab handed to an agent. p-gated: an agent reads only its own. */
export const KIND_WORKSPACE_TAB_GRANT = 44400;
/** The driver seat changing hands other than by grant. */
export const KIND_WORKSPACE_TAB_TAKEOVER = 44401;
```

Mobile mirrors these in `mobile/lib/shared/relay/nostr_models.dart` and the two
must stay in sync. B2 does not add the mobile surface, so **do not** add them
there yet; note it in your report so it is not forgotten when mobile grows a
workspace.

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/shared/constants/kinds.ts \
        desktop/src/shared/constants/workspaceKinds.test.mjs
git commit -s -m "feat(workspace): desktop tab ownership kind constants"
```

---

## Task 2: Ownership store

**Files:**
- Create: `desktop/src/features/workspace/lib/tabOwnership.ts`
- Test: `desktop/src/features/workspace/lib/tabOwnership.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `type TabOwnership = { owner: string; driver: string }`,
  `getTabOwnership(channelId: string, tabId: string): TabOwnership | null`,
  `setTabOwnership(channelId: string, tabId: string, ownership: TabOwnership): void`,
  `useTabOwnership(channelId: string | undefined, tabId: string | null): TabOwnership | null`,
  `resetTabOwnership(): void`.

Deliberately **not** persisted to localStorage. Ownership is relay truth; a
stale cached driver is worse than no answer, because it would show a tab as
yours when an agent holds it.

- [ ] **Step 1: Write the failing test**

Create `desktop/src/features/workspace/lib/tabOwnership.test.mjs`:

```javascript
import assert from "node:assert/strict";
import test from "node:test";

let importSequence = 0;
const fresh = () => import(`./tabOwnership.ts?test=${importSequence++}`);

const HUMAN = "a".repeat(64);
const AGENT = "b".repeat(64);

test("an unknown tab has no ownership rather than a guessed one", async () => {
  const mod = await fresh();
  assert.equal(mod.getTabOwnership("chan-a", "tab-1"), null);
});

test("ownership is per channel and per tab", async () => {
  const mod = await fresh();
  mod.setTabOwnership("chan-a", "tab-1", { owner: HUMAN, driver: AGENT });
  assert.deepEqual(mod.getTabOwnership("chan-a", "tab-1"), {
    owner: HUMAN,
    driver: AGENT,
  });
  assert.equal(mod.getTabOwnership("chan-b", "tab-1"), null);
  assert.equal(mod.getTabOwnership("chan-a", "tab-2"), null);
});

test("a later head replaces an earlier one", async () => {
  const mod = await fresh();
  mod.setTabOwnership("chan-a", "tab-1", { owner: HUMAN, driver: AGENT });
  mod.setTabOwnership("chan-a", "tab-1", { owner: HUMAN, driver: HUMAN });
  assert.equal(mod.getTabOwnership("chan-a", "tab-1").driver, HUMAN);
});

test("ownership is never persisted, so a reload cannot show a stale driver", async () => {
  const writes = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: (key, value) => void writes.push([key, value]),
      removeItem: () => {},
    },
  });
  try {
    const mod = await fresh();
    mod.setTabOwnership("chan-a", "tab-1", { owner: HUMAN, driver: AGENT });
    assert.deepEqual(writes, [], `ownership must not be cached: ${JSON.stringify(writes)}`);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  }
});

test("reset clears every channel", async () => {
  const mod = await fresh();
  mod.setTabOwnership("chan-a", "tab-1", { owner: HUMAN, driver: AGENT });
  mod.setTabOwnership("chan-b", "tab-2", { owner: HUMAN, driver: AGENT });
  mod.resetTabOwnership();
  assert.equal(mod.getTabOwnership("chan-a", "tab-1"), null);
  assert.equal(mod.getTabOwnership("chan-b", "tab-2"), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL, `Cannot find module './tabOwnership.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
import * as React from "react";

/**
 * Who owns a tab and who is currently driving it.
 *
 * Both are pubkey hex. `driver` is the single active driver: the human, or one
 * agent. Mirrored from the relay's tab head events (B1), never invented here.
 */
export type TabOwnership = {
  owner: string;
  driver: string;
};

const listeners = new Set<() => void>();

/** `${channelId} ${tabId}` to ownership. Never persisted: see the test. */
let ownership: Record<string, TabOwnership> = {};

function key(channelId: string, tabId: string): string {
  return `${channelId} ${tabId}`;
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read a tab's ownership outside React. Null means the relay has not said. */
export function getTabOwnership(
  channelId: string,
  tabId: string,
): TabOwnership | null {
  return ownership[key(channelId, tabId)] ?? null;
}

/** Record what a tab head event said. */
export function setTabOwnership(
  channelId: string,
  tabId: string,
  next: TabOwnership,
): void {
  ownership = { ...ownership, [key(channelId, tabId)]: next };
  emit();
}

/** Clear every channel's ownership. Wired into resetCommunityState(). */
export function resetTabOwnership(): void {
  ownership = {};
  emit();
}

/** Subscribe a component to one tab's ownership. */
export function useTabOwnership(
  channelId: string | undefined,
  tabId: string | null,
): TabOwnership | null {
  return React.useSyncExternalStore(
    subscribe,
    () => (channelId && tabId ? getTabOwnership(channelId, tabId) : null),
    () => null,
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/workspace/lib/tabOwnership.ts \
        desktop/src/features/workspace/lib/tabOwnership.test.mjs
git commit -s -m "feat(workspace): per-tab ownership store"
```

---

## Task 3: Ownership decision rules

Every "can I?" and "what does it say?" in one pure, tested module, so the UI
components stay dumb and the rules are provable without rendering anything.

**Files:**
- Create: `desktop/src/features/workspace/lib/ownershipDecisions.ts`
- Test: `desktop/src/features/workspace/lib/ownershipDecisions.test.mjs`

**Interfaces:**
- Consumes: `TabOwnership` (Task 2).
- Produces:
  `isDrivenByMe(ownership: TabOwnership | null, me: string): boolean`,
  `canTakeOver(ownership: TabOwnership | null, me: string): boolean`,
  `canGrant(ownership: TabOwnership | null, me: string): boolean`,
  `driverLabel(ownership: TabOwnership | null, me: string, nameFor: (pubkey: string) => string): string | null`.

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import test from "node:test";

const {
  canGrant,
  canTakeOver,
  driverLabel,
  isDrivenByMe,
} = await import("./ownershipDecisions.ts");

const ME = "a".repeat(64);
const AGENT = "b".repeat(64);
const OTHER = "c".repeat(64);
const nameFor = (pubkey) => (pubkey === AGENT ? "Scout" : "Someone");

test("an unknown ownership is treated as mine, because a local-only tab has no head yet", () => {
  assert.equal(isDrivenByMe(null, ME), true);
  assert.equal(canTakeOver(null, ME), false, "nothing to take back");
  assert.equal(canGrant(null, ME), true, "a local tab can still be handed over");
});

test("a tab I drive needs no takeover", () => {
  const mine = { owner: ME, driver: ME };
  assert.equal(isDrivenByMe(mine, ME), true);
  assert.equal(canTakeOver(mine, ME), false);
  assert.equal(canGrant(mine, ME), true);
});

test("a tab an agent drives can be taken back by its owner", () => {
  const granted = { owner: ME, driver: AGENT };
  assert.equal(isDrivenByMe(granted, ME), false);
  assert.equal(canTakeOver(granted, ME), true);
  assert.equal(canGrant(granted, ME), true, "the owner may redirect it");
});

test("someone else's tab is not mine to take or hand on", () => {
  const theirs = { owner: OTHER, driver: AGENT };
  assert.equal(canTakeOver(theirs, ME), false);
  assert.equal(canGrant(theirs, ME), false);
});

test("pubkey comparison ignores case, because hex casing is not identity", () => {
  const mine = { owner: ME.toUpperCase(), driver: ME.toUpperCase() };
  assert.equal(isDrivenByMe(mine, ME), true);
});

test("the label names the driver and says nothing when it is me", () => {
  assert.equal(driverLabel({ owner: ME, driver: ME }, ME, nameFor), null);
  assert.equal(
    driverLabel({ owner: ME, driver: AGENT }, ME, nameFor),
    "Scout is driving",
  );
  assert.equal(driverLabel(null, ME, nameFor), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL, `Cannot find module './ownershipDecisions.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { TabOwnership } from "@/features/workspace/lib/tabOwnership";

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether the local human is the current driver.
 *
 * A tab with no head yet is local-only and therefore mine: Phase A tabs exist
 * before any ownership event does, and showing them as driven by a stranger
 * would be both wrong and alarming.
 */
export function isDrivenByMe(ownership: TabOwnership | null, me: string): boolean {
  return ownership === null || same(ownership.driver, me);
}

/** Whether "Take over" should be offered: someone else drives a tab I own. */
export function canTakeOver(ownership: TabOwnership | null, me: string): boolean {
  if (ownership === null) return false;
  return !same(ownership.driver, me) && same(ownership.owner, me);
}

/** Whether this tab can be handed to an agent. Owners and drivers may. */
export function canGrant(ownership: TabOwnership | null, me: string): boolean {
  if (ownership === null) return true;
  return same(ownership.owner, me) || same(ownership.driver, me);
}

/** What to show when someone else is driving. Null when it is me. */
export function driverLabel(
  ownership: TabOwnership | null,
  me: string,
  nameFor: (pubkey: string) => string,
): string | null {
  if (isDrivenByMe(ownership, me) || ownership === null) return null;
  return `${nameFor(ownership.driver)} is driving`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/workspace/lib/ownershipDecisions.ts \
        desktop/src/features/workspace/lib/ownershipDecisions.test.mjs
git commit -s -m "feat(workspace): pure ownership decision rules"
```

---

## Task 4: Event builders

**Files:**
- Create: `desktop/src/features/workspace/lib/tabOwnershipEvents.ts`
- Test: `desktop/src/features/workspace/lib/tabOwnershipEvents.test.mjs`

**Interfaces:**
- Consumes: kind constants (Task 1).
- Produces:
  `buildTabHeadTags(input: { tabId, channelId, tabKind, title, owner, driver }): string[][]`,
  `buildTabGrantTags(input: { tabId, channelId, grantee }): string[][]`,
  `buildTabTakeoverTags(input: { tabId, channelId, driver, reason: "human-takeover" | "release" }): string[][]`.

Builders are pure and tested; the thin publish wrappers that hand these to
`relayClient.publishEvent` are not unit-tested and are proven in Task 10's E2E.

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import test from "node:test";

const {
  buildTabGrantTags,
  buildTabHeadTags,
  buildTabTakeoverTags,
} = await import("./tabOwnershipEvents.ts");

const HUMAN = "a".repeat(64);
const AGENT = "b".repeat(64);
const tagValue = (tags, name) => tags.find((tag) => tag[0] === name)?.[1];

test("a head carries identity and ownership, and nothing else", () => {
  const tags = buildTabHeadTags({
    tabId: "tab-1",
    channelId: "chan-a",
    tabKind: "scratchpad",
    title: "Notes",
    owner: HUMAN,
    driver: AGENT,
  });
  assert.equal(tagValue(tags, "d"), "tab-1");
  assert.equal(tagValue(tags, "h"), "chan-a");
  assert.equal(tagValue(tags, "tab-kind"), "scratchpad");
  assert.equal(tagValue(tags, "title"), "Notes");
  assert.equal(tagValue(tags, "owner"), HUMAN);
  assert.equal(tagValue(tags, "driver"), AGENT);
  assert.deepEqual(
    tags.map((tag) => tag[0]).sort(),
    ["d", "driver", "h", "owner", "tab-kind", "title"],
    "a head must carry no tag beyond identity and ownership",
  );
});

test("a head never carries the payload", () => {
  const tags = buildTabHeadTags({
    tabId: "tab-1",
    channelId: "chan-a",
    tabKind: "scratchpad",
    title: "Notes",
    owner: HUMAN,
    driver: HUMAN,
    // A caller passing payload through must not leak it. Extra keys are ignored.
    payload: { text: "secret scratchpad text" },
  });
  assert.ok(
    !JSON.stringify(tags).includes("secret scratchpad text"),
    `payload leaked into a relay event: ${JSON.stringify(tags)}`,
  );
});

test("a grant addresses exactly one agent", () => {
  const tags = buildTabGrantTags({
    tabId: "tab-1",
    channelId: "chan-a",
    grantee: AGENT,
  });
  assert.equal(tagValue(tags, "tab"), "tab-1");
  assert.equal(tagValue(tags, "h"), "chan-a");
  assert.equal(tagValue(tags, "p"), AGENT);
  assert.equal(tags.filter((tag) => tag[0] === "p").length, 1);
});

test("a takeover records why", () => {
  for (const reason of ["human-takeover", "release"]) {
    const tags = buildTabTakeoverTags({
      tabId: "tab-1",
      channelId: "chan-a",
      driver: HUMAN,
      reason,
    });
    assert.equal(tagValue(tags, "reason"), reason);
    assert.equal(tagValue(tags, "driver"), HUMAN);
  }
});

test("a blank title is refused rather than published", () => {
  assert.throws(
    () =>
      buildTabHeadTags({
        tabId: "tab-1",
        channelId: "chan-a",
        tabKind: "scratchpad",
        title: "   ",
        owner: HUMAN,
        driver: HUMAN,
      }),
    /title/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL, `Cannot find module './tabOwnershipEvents.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
/**
 * Build the tags for the three workspace ownership events.
 *
 * These carry identity and ownership only. A tab's `payload` is device-local
 * and must never reach the relay: a file path or a PTY handle is meaningless on
 * another machine, and scratchpad text is nobody else's business. The builders
 * take explicit fields rather than a whole tab so that a payload cannot be
 * passed through by accident.
 */

type HeadInput = {
  tabId: string;
  channelId: string;
  tabKind: string;
  title: string;
  owner: string;
  driver: string;
};

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`workspace tab event needs a non-empty ${name}`);
  return trimmed;
}

/** Tags for a tab head. `d` is the tab id, so the head replaces by tab. */
export function buildTabHeadTags(input: HeadInput): string[][] {
  return [
    ["d", required(input.tabId, "tabId")],
    ["h", required(input.channelId, "channelId")],
    ["tab-kind", required(input.tabKind, "tabKind")],
    ["title", required(input.title, "title")],
    ["owner", required(input.owner, "owner")],
    ["driver", required(input.driver, "driver")],
  ];
}

/** Tags for handing a tab to an agent. */
export function buildTabGrantTags(input: {
  tabId: string;
  channelId: string;
  grantee: string;
}): string[][] {
  return [
    ["tab", required(input.tabId, "tabId")],
    ["h", required(input.channelId, "channelId")],
    ["p", required(input.grantee, "grantee")],
  ];
}

/** Tags for the driver seat changing hands other than by grant. */
export function buildTabTakeoverTags(input: {
  tabId: string;
  channelId: string;
  driver: string;
  reason: "human-takeover" | "release";
}): string[][] {
  return [
    ["tab", required(input.tabId, "tabId")],
    ["h", required(input.channelId, "channelId")],
    ["driver", required(input.driver, "driver")],
    ["reason", input.reason],
  ];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/workspace/lib/tabOwnershipEvents.ts \
        desktop/src/features/workspace/lib/tabOwnershipEvents.test.mjs
git commit -s -m "feat(workspace): tab ownership event builders"
```

---

## Task 5: Hydrate ownership from the relay

**Files:**
- Create: `desktop/src/features/workspace/lib/useTabOwnershipSync.ts`
- Modify: `desktop/src/features/workspace/ui/ChannelWorkspace.tsx`

**Interfaces:**
- Consumes: `setTabOwnership` (Task 2), `KIND_WORKSPACE_TAB_HEAD` (Task 1).
- Produces: `useTabOwnershipSync(channelId: string | undefined): void`.

- [ ] **Step 1: Read the working path first**

Read how an existing feature fetches and live-subscribes relay events. The
session exposes `fetchEvents(filter)` and `subscribeLive(...)` on
`desktop/src/shared/api/relayClientSession.ts`, reached through
`relayClient` from `@/shared/api/relayClient`. Copy the shape a neighbouring
feature uses, including how it unsubscribes on unmount. Report which feature you
copied.

- [ ] **Step 2: Write the hook**

```typescript
import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import { KIND_WORKSPACE_TAB_HEAD } from "@/shared/constants/kinds";
import { setTabOwnership } from "@/features/workspace/lib/tabOwnership";

function tagValue(tags: string[][], name: string): string | null {
  return tags.find((tag) => tag[0] === name)?.[1] ?? null;
}

/**
 * Keep the ownership store in step with the channel's tab heads.
 *
 * Reads ownership only. The head carries no payload, so nothing here can
 * overwrite what a tab contains: the local store stays the source of truth for
 * tab existence, order and contents, and the relay is the source of truth for
 * who is driving.
 */
export function useTabOwnershipSync(channelId: string | undefined): void {
  React.useEffect(() => {
    if (!channelId) return;
    let cancelled = false;

    const apply = (event: { tags: string[][] }) => {
      const tabId = tagValue(event.tags, "d");
      const owner = tagValue(event.tags, "owner");
      const driver = tagValue(event.tags, "driver");
      if (!tabId || !owner || !driver) return;
      setTabOwnership(channelId, tabId, { owner, driver });
    };

    const filter = { kinds: [KIND_WORKSPACE_TAB_HEAD], "#h": [channelId] };

    void relayClient
      .fetchEvents(filter)
      .then((events) => {
        if (!cancelled) for (const event of events) apply(event);
      })
      .catch(() => {
        // Ownership simply stays unknown, which the UI renders as "mine".
      });

    const subscription = relayClient.subscribeLive(filter, apply);

    return () => {
      cancelled = true;
      void subscription.then((unsubscribe) => unsubscribe?.());
    };
  }, [channelId]);
}
```

Adjust `fetchEvents`/`subscribeLive` call shapes to whatever Step 1 found. The
filter **must** name `kinds`: an open-ended query hits the relay's p-gate and
returns 403.

- [ ] **Step 3: Call it from the workspace shell**

In `ChannelWorkspace.tsx`, add `useTabOwnershipSync(channelId);` beside the
existing `registerAllTabKinds()` call.

- [ ] **Step 4: Verify**

Run: `cd desktop && pnpm check && pnpm typecheck`

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/workspace/lib/useTabOwnershipSync.ts \
        desktop/src/features/workspace/ui/ChannelWorkspace.tsx
git commit -s -m "feat(workspace): hydrate tab ownership from the relay"
```

---

## Task 6: Driver badge on the tab strip

**Files:**
- Create: `desktop/src/features/workspace/ui/TabDriverBadge.tsx`
- Modify: `desktop/src/features/workspace/ui/WorkspaceTabStrip.tsx`

**Interfaces:**
- Consumes: `useTabOwnership` (Task 2), `isDrivenByMe` (Task 3).
- Produces: `TabDriverBadge: React.ComponentType<{ channelId: string; tabId: string; myPubkey: string }>`.

- [ ] **Step 1: Write the badge**

```tsx
import * as React from "react";
import { Bot } from "lucide-react";

import { isDrivenByMe } from "@/features/workspace/lib/ownershipDecisions";
import { useTabOwnership } from "@/features/workspace/lib/tabOwnership";

type TabDriverBadgeProps = {
  channelId: string;
  tabId: string;
  myPubkey: string;
};

/**
 * A small mark on a tab an agent is driving.
 *
 * Renders nothing for a tab the human drives, which is the common case: a badge
 * on every tab would be noise, and the signal here is "something else is moving
 * this one".
 */
export function TabDriverBadge({
  channelId,
  tabId,
  myPubkey,
}: TabDriverBadgeProps): React.JSX.Element | null {
  const ownership = useTabOwnership(channelId, tabId);
  if (isDrivenByMe(ownership, myPubkey)) return null;
  return (
    <Bot
      aria-label="An agent is driving this tab"
      className="size-3 shrink-0 text-muted-foreground"
      data-testid={`workspace-tab-driver-${tabId}`}
    />
  );
}
```

- [ ] **Step 2: Render it in the strip**

`WorkspaceTabStrip` currently takes `tabs`, `activeTabId`, `isExpanded` and four
callbacks. Add `channelId: string` and `myPubkey: string` props, and render
`<TabDriverBadge …/>` inside each tab's `<div>`, before the title button.

Pass both through from `ChannelWorkspace`. Get the local pubkey from the same
hook the rest of the app uses (`useIdentityQuery` in `@/shared/api/hooks`);
check how a neighbouring component reads it rather than assuming the field name.

- [ ] **Step 3: Verify**

Run: `cd desktop && pnpm check && pnpm typecheck`

Expected: both exit 0. Watch `check:px-text`: the badge uses `size-3`, a
dimension token, not a text size, so it is fine. Do not add an arbitrary text
size for the badge.

- [ ] **Step 4: Commit**

```bash
git add desktop/src/features/workspace/ui/TabDriverBadge.tsx \
        desktop/src/features/workspace/ui/WorkspaceTabStrip.tsx \
        desktop/src/features/workspace/ui/ChannelWorkspace.tsx
git commit -s -m "feat(workspace): show which tabs an agent is driving"
```

---

## Task 7: Driver banner and Take over

**Files:**
- Create: `desktop/src/features/workspace/ui/DriverBanner.tsx`
- Modify: `desktop/src/features/workspace/ui/ChannelWorkspace.tsx`

**Interfaces:**
- Consumes: `canTakeOver`, `driverLabel` (Task 3), `buildTabTakeoverTags`,
  `buildTabHeadTags` (Task 4), `useTabOwnership` (Task 2).
- Produces: `DriverBanner: React.ComponentType<{ channelId: string; tab: WorkspaceTab; myPubkey: string }>`.

- [ ] **Step 1: Write the banner**

```tsx
import * as React from "react";

import { canTakeOver, driverLabel } from "@/features/workspace/lib/ownershipDecisions";
import { useTabOwnership } from "@/features/workspace/lib/tabOwnership";
import { takeOverTab } from "@/features/workspace/lib/tabOwnershipEvents";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";

type DriverBannerProps = {
  channelId: string;
  tab: WorkspaceTab;
  myPubkey: string;
  nameFor: (pubkey: string) => string;
};

/**
 * Who is driving this tab, and the way back.
 *
 * Shown only when someone else drives, above the tab body rather than over it:
 * the spec's Pause and Take over must always be available, and a banner that
 * covered the content would defeat watching the agent work.
 */
export function DriverBanner({
  channelId,
  tab,
  myPubkey,
  nameFor,
}: DriverBannerProps): React.JSX.Element | null {
  const ownership = useTabOwnership(channelId, tab.id);
  const label = driverLabel(ownership, myPubkey, nameFor);
  if (!label) return null;
  return (
    <div
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="workspace-driver-banner"
    >
      <span>{label}</span>
      {canTakeOver(ownership, myPubkey) ? (
        <button
          className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
          data-testid="workspace-take-over"
          onClick={() => void takeOverTab(channelId, tab, myPubkey)}
          type="button"
        >
          Take over
        </button>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Add the publish helper**

Append to `tabOwnershipEvents.ts`:

```typescript
import { relayClient } from "@/shared/api/relayClient";
import {
  KIND_WORKSPACE_TAB_HEAD,
  KIND_WORKSPACE_TAB_TAKEOVER,
} from "@/shared/constants/kinds";
import { getTabOwnership, setTabOwnership } from "@/features/workspace/lib/tabOwnership";
import type { WorkspaceTab } from "@/features/workspace/lib/workspaceTabs";

/**
 * Take a tab back from whoever is driving it.
 *
 * Publishes the audit event first, then the new head. In that order a crash
 * between the two leaves a recorded takeover with a stale head, which the next
 * head write corrects; the reverse order would leave a silent driver change.
 */
export async function takeOverTab(
  channelId: string,
  tab: WorkspaceTab,
  myPubkey: string,
): Promise<void> {
  const ownership = getTabOwnership(channelId, tab.id);
  const owner = ownership?.owner ?? myPubkey;
  await relayClient.publishEvent(
    {
      kind: KIND_WORKSPACE_TAB_TAKEOVER,
      content: "",
      tags: buildTabTakeoverTags({
        tabId: tab.id,
        channelId,
        driver: myPubkey,
        reason: "human-takeover",
      }),
    },
    "Taking the tab back timed out.",
    "Could not take the tab back.",
  );
  await relayClient.publishEvent(
    {
      kind: KIND_WORKSPACE_TAB_HEAD,
      content: "",
      tags: buildTabHeadTags({
        tabId: tab.id,
        channelId,
        tabKind: tab.kind,
        title: tab.title,
        owner,
        driver: myPubkey,
      }),
    },
    "Updating the tab owner timed out.",
    "Could not update the tab owner.",
  );
  setTabOwnership(channelId, tab.id, { owner, driver: myPubkey });
}
```

Match `publishEvent`'s real signature and the real `RelayEvent` shape from
`@/shared/api/types`; the fields above are indicative. Report any difference.

- [ ] **Step 3: Render it above the tab body**

In `ChannelWorkspace.tsx`, render `<DriverBanner …/>` between the tab strip and
the body container, only when `activeTab` exists.

- [ ] **Step 4: Verify**

Run: `cd desktop && pnpm check && pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add desktop/src/features/workspace/ui/DriverBanner.tsx \
        desktop/src/features/workspace/lib/tabOwnershipEvents.ts \
        desktop/src/features/workspace/ui/ChannelWorkspace.tsx
git commit -s -m "feat(workspace): driver banner with take over"
```

---

## Task 8: Typing takes the tab back

The spec: "When the human interacts with a page (click, type, scroll), the
active agent's turn is paused". For `scratchpad`, typing is the interaction.

**Files:**
- Modify: `desktop/src/features/workspace/kinds/scratchpadKind.tsx`
- Test: `desktop/src/features/workspace/lib/ownershipDecisions.test.mjs` (extend)

**Interfaces:**
- Consumes: `isDrivenByMe` (Task 3), `takeOverTab` (Task 7).
- Produces: `shouldTakeOverOnInteraction(ownership: TabOwnership | null, me: string): boolean`.

- [ ] **Step 1: Write the failing test**

Add to `ownershipDecisions.test.mjs`:

```javascript
test("typing takes the tab back only when an agent holds it", async () => {
  const { shouldTakeOverOnInteraction } = await import("./ownershipDecisions.ts");
  assert.equal(shouldTakeOverOnInteraction(null, ME), false, "a local tab needs nothing");
  assert.equal(shouldTakeOverOnInteraction({ owner: ME, driver: ME }, ME), false);
  assert.equal(shouldTakeOverOnInteraction({ owner: ME, driver: AGENT }, ME), true);
  assert.equal(
    shouldTakeOverOnInteraction({ owner: OTHER, driver: AGENT }, ME),
    false,
    "typing in someone else's tab must not seize it",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL, `shouldTakeOverOnInteraction is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `ownershipDecisions.ts`:

```typescript
/**
 * Whether a human interaction should take the tab back.
 *
 * Same rule as the Take over button: an agent is driving and I own it. Typing
 * into a tab I do not own must not seize it, or two humans in one channel would
 * fight over an agent's tab by accident.
 */
export function shouldTakeOverOnInteraction(
  ownership: TabOwnership | null,
  me: string,
): boolean {
  return canTakeOver(ownership, me);
}
```

- [ ] **Step 4: Wire it into the scratchpad body**

In `ScratchpadBody`, before the existing `updateTabPayload` call in `onChange`,
take the tab back if an agent holds it:

```tsx
const ownership = useTabOwnership(channelId, tab.id);
const myPubkey = /* the same identity hook Task 6 used */;

const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
  if (shouldTakeOverOnInteraction(ownership, myPubkey)) {
    void takeOverTab(channelId, tab, myPubkey);
  }
  updateTabPayload(channelId, tab.id, { text: event.target.value });
};
```

The local edit applies immediately either way. Blocking the keystroke on a
network round trip would make the human's own app feel broken, which is a worse
failure than a takeover event landing a moment late.

- [ ] **Step 5: Run the test to verify it passes**

Expected: PASS (7 tests in that file).

- [ ] **Step 6: Commit**

```bash
git add desktop/src/features/workspace/lib/ownershipDecisions.ts \
        desktop/src/features/workspace/lib/ownershipDecisions.test.mjs \
        desktop/src/features/workspace/kinds/scratchpadKind.tsx
git commit -s -m "feat(workspace): typing takes a tab back from an agent"
```

---

## Task 9: Agent-working indicator and community teardown

The one place the spec is emphatic about what **not** to do: an agent starting
work must never flip the channel into workspace mode.

**Files:**
- Modify: `desktop/src/features/channels/ui/ChannelScreenHeader.tsx`
- Modify: `desktop/src/features/communities/useCommunityInit.ts`
- Test: `desktop/src/features/workspace/lib/ownershipDecisions.test.mjs` (extend)

**Interfaces:**
- Consumes: `useChannelWorkingAgentPubkeys` from
  `@/features/agents/agentWorkingSignal`, `resetTabOwnership` (Task 2).
- Produces: `shouldShowAgentWorkingDot(workingPubkeys: string[], surfaceMode: "timeline" | "workspace"): boolean`.

- [ ] **Step 1: Write the failing test**

```javascript
test("the header dot appears when an agent works and the human is on the timeline", async () => {
  const { shouldShowAgentWorkingDot } = await import("./ownershipDecisions.ts");
  assert.equal(shouldShowAgentWorkingDot([], "timeline"), false);
  assert.equal(shouldShowAgentWorkingDot([AGENT], "timeline"), true);
  assert.equal(
    shouldShowAgentWorkingDot([AGENT], "workspace"),
    false,
    "in workspace mode the work is already on screen, so the dot is noise",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Expected: FAIL, `shouldShowAgentWorkingDot is not a function`.

- [ ] **Step 3: Write the implementation**

```typescript
import type { ChannelSurfaceMode } from "@/features/workspace/lib/channelSurfaceMode";

/**
 * Whether the channel header's workspace button should show a working dot.
 *
 * This indicator is the ONLY thing an agent's activity changes about the
 * channel. It must never flip the surface into workspace mode: replacing the
 * conversation someone is reading is far more disruptive than a dot, and
 * entering the workspace stays a human act.
 */
export function shouldShowAgentWorkingDot(
  workingPubkeys: string[],
  surfaceMode: ChannelSurfaceMode,
): boolean {
  return workingPubkeys.length > 0 && surfaceMode === "timeline";
}
```

- [ ] **Step 4: Render the dot**

In `ChannelScreenHeader.tsx`, beside the existing workspace toggle added in
Phase A, read `useChannelWorkingAgentPubkeys(channelId)` and the existing
`surfaceMode`, and when `shouldShowAgentWorkingDot(...)` is true render a small
dot positioned on the button, with `data-testid="channel-agent-working-dot"` and
an `aria-label` naming how many agents are working.

Do **not** call `setChannelSurfaceMode` anywhere in this task.

- [ ] **Step 5: Reset the store on community switch**

In `useCommunityInit.ts`, import `resetTabOwnership` and call it inside
`resetCommunityState()` beside `resetWorkspaceTabs()` and
`resetChannelSurfaceModes()`. Add a bullet to the singleton list in `AGENTS.md`:

```markdown
- `resetTabOwnership()` — per-tab owner/driver mirrored from the relay
```

Stage `AGENTS.md`, not `CLAUDE.md`: `CLAUDE.md` is a symlink (mode 120000) and
staging it is a no-op that silently drops the change.

- [ ] **Step 6: Verify**

Run: `cd desktop && pnpm check && pnpm typecheck`

If `pnpm check` fails on the native inventory, your `useCommunityInit.ts` edit
shifted the recorded line numbers of the `invoke(...)` callsites in that file.
Run `pnpm generate:native-inventory` and commit the result. This happened in
Phase A for exactly this file.

- [ ] **Step 7: Commit**

```bash
git add desktop/src/features/workspace/lib/ownershipDecisions.ts \
        desktop/src/features/workspace/lib/ownershipDecisions.test.mjs \
        desktop/src/features/channels/ui/ChannelScreenHeader.tsx \
        desktop/src/features/communities/useCommunityInit.ts \
        AGENTS.md desktop/native-inventory.json
git commit -s -m "feat(workspace): agent-working indicator and ownership teardown"
```

---

## Task 10: E2E spec

**Files:**
- Create: `desktop/tests/e2e/workspace-ownership.spec.ts`
- Modify: `desktop/playwright.config.ts` (`smoke` project `testMatch`)

**Interfaces:**
- Consumes: the `data-testid` values from Tasks 6, 7 and 9.
- Produces: three distinct screenshots for the PR body.

- [ ] **Step 1: Write the spec**

Model it on `desktop/tests/e2e/channel-workspace.spec.ts` from Phase A. Two
things that spec learned the hard way:

- Import the bridge from `../helpers/bridge` (there is no `e2eBridge`).
- The Playwright web server is `python3 -m http.server`, a static file server
  with no SPA fallback, so **deep links 404**. Navigate `page.goto("/")` then
  click `getByTestId("channel-general")`.

```typescript
import { expect, test } from "@playwright/test";

import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

test.describe("workspace ownership", () => {
  test.beforeEach(async ({ page }) => {
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await page.getByTestId("channel-workspace-toggle").click();
    await page.getByTestId("workspace-create-scratchpad").click();
  });

  test("a tab I drive shows no banner and no badge", async ({ page }) => {
    await expect(page.getByTestId("workspace-scratchpad-body")).toBeVisible();
    await expect(page.getByTestId("workspace-driver-banner")).toHaveCount(0);
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace-ownership/01-driven-by-me.png",
    });
  });

  test("a tab an agent drives shows the banner and a take over control", async ({
    page,
  }) => {
    await page.evaluate(() => window.__BUZZ_E2E_SET_TAB_DRIVER__?.("agent"));

    const banner = page.getByTestId("workspace-driver-banner");
    await expect(banner).toBeVisible();
    await expect(page.getByTestId("workspace-take-over")).toBeVisible();
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace-ownership/02-agent-driving.png",
    });

    await page.getByTestId("workspace-take-over").click();
    await expect(banner).toHaveCount(0, {
      // Taking over must clear the banner, not just record an event.
    });
    await waitForAnimations(page);
    await page.getByTestId("channel-workspace").screenshot({
      path: "test-results/workspace-ownership/03-taken-back.png",
    });
  });

  test("an agent working never flips the channel into workspace mode", async ({
    page,
  }) => {
    await page.getByTestId("channel-workspace-toggle").click();
    await expect(page.getByTestId("channel-workspace")).toHaveCount(0);

    await page.evaluate(() => window.__BUZZ_E2E_SET_TAB_DRIVER__?.("agent"));

    await expect(page.getByTestId("channel-workspace")).toHaveCount(
      0,
      "an agent starting work must never take over the content column",
    );
    await expect(page.getByTestId("channel-agent-working-dot")).toBeVisible();
  });
});
```

`__BUZZ_E2E_SET_TAB_DRIVER__` does not exist yet. Add it to the mock bridge
beside the existing `__BUZZ_E2E_EMIT_MOCK_MESSAGE__` helper in
`desktop/tests/helpers/bridge.ts`, as a thin wrapper over `setTabOwnership`.
Report where you put it.

- [ ] **Step 2: Register the spec**

Add `workspace-ownership.spec.ts` to the `smoke` project's `testMatch` in
`desktop/playwright.config.ts`.

- [ ] **Step 3: Run it**

Run: `cd desktop && pnpm test:e2e:smoke`

**Never** run `pnpm run build` then `playwright test` by hand: a plain build
strips the mock Tauri bridge and every spec fails with `Cannot read properties
of undefined (reading 'invoke')`, which looks like a product bug and is a build
mistake. Kill anything on port 4173 first, since `reuseExistingServer: true`
serves stale code otherwise.

Expected: PASS (3 tests).

- [ ] **Step 4: Verify the screenshots are distinct**

```bash
shasum -a 256 desktop/test-results/workspace-ownership/*.png
```

All three hashes must be unique. Identical hashes mean two shots captured the
same state: fix the spec, do not post them. Then open each and confirm it shows
what its name claims.

- [ ] **Step 5: Commit**

```bash
git add desktop/tests/e2e/workspace-ownership.spec.ts \
        desktop/playwright.config.ts desktop/tests/helpers/bridge.ts
git commit -s -m "test(workspace): e2e coverage for tab ownership"
```

---

## Task 11: Full gate and PR

- [ ] **Step 1: Run the whole local gate**

```bash
just ci
cd desktop && pnpm test:e2e:smoke
```

The full smoke suite matters here: this plan edits `ChannelScreenHeader.tsx` and
`scratchpadKind.tsx`, both shared surfaces with existing specs. Triage any
failure against `origin/develop` before calling it pre-existing. `scroll-history`
is a known pre-existing failure that reproduces on develop.

- [ ] **Step 2: Post the screenshots**

```bash
./scripts/post-screenshots.sh <PR-number> desktop/test-results/workspace-ownership <body-template>
```

Never `buzz upload` or a relay media URL; those fail through GitHub's camo proxy.

- [ ] **Step 3: Open the PR and arm auto-merge**

```bash
gh pr create --repo AI-Native-Ventures/Colony --base develop \
  --title "feat(workspace): tab ownership desktop surface (phase B2)" --body-file <body>
gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto
```

`--auto` is required; the merge queue owns the strategy on `develop`. Every `gh`
command needs `--repo`, since bare `gh` resolves to upstream `block/buzz`. Note
the queue squashes regardless of `--merge`.

---

## Self-review

**Spec coverage.** One driver per tab, visible: Tasks 2, 6 and 7. Take over
always available: Task 7. Human interaction pauses the agent: Task 8. Never
hijack the content column, header indicator instead: Task 9, asserted in Task 10.
Grant a tab to an agent: builders in Task 4, published in Task 7's helper (the
grant UI itself is a menu item on the tab, added in Task 6's strip edit).
Community teardown: Task 9.

**Deliberately not covered, and listed in "Out of scope":** approvals, evidence,
ledger, the Background toggle and session cap, and per-kind live representation.
Each needs either the approvals surface or a remote-driven kind, and neither
exists yet.

**Type consistency.** `TabOwnership`'s two fields are identical in Tasks 2, 3, 6,
7, 8 and 9. `isDrivenByMe`, `canTakeOver`, `canGrant`, `driverLabel`,
`shouldTakeOverOnInteraction` and `shouldShowAgentWorkingDot` all live in
`ownershipDecisions.ts` and all take `ownership` first and `me` second.
`buildTabHeadTags` in Task 4 produces exactly the six tags `parse_tab_head`
requires in B1 Task 2 (`d`, `h`, `tab-kind`, `title`, `owner`, `driver`), and
`buildTabTakeoverTags`'s reasons match B1's closed set (`human-takeover`,
`release`).
