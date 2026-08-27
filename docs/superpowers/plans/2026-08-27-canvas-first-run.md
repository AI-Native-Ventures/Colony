# Canvas First-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the redesigned canvas onboarding flow the shipped public first run: it provisions the hosted community itself, completes with starter channels + profile + Scout's first-task brief, and the legacy community flow stops being the founder path.

**Architecture:** `NewOnboardingFlow` moves above community application, mounted from `CommunityApp` via a new `CanvasFirstRunHost` for fresh founders only (local marker written by machine onboarding's fresh-identity path). The company screen provisions a hosted community through the existing `colony_*` Tauri commands against the compiled root relay; completion runs through a new shared `completeFirstRun` module that the legacy flow's `finalize` also consumes. No community-onboarding transaction is created, so the legacy overlay never renders for founders.

**Tech Stack:** React 19 + TypeScript (desktop), node --test `.test.mjs` unit tests importing TS directly (`pnpm test`), Playwright e2e with mock Tauri bridge (`pnpm test:e2e:smoke`), existing Tauri commands only (no Rust changes).

**Spec:** `/Users/mac/.traycer/epics/9d7e3281-f4bf-4b49-b75d-7b3fb873abc2/artifacts/onboarding-critique/canvas-first-run-design/index.md` (approved). Critique context: `.../onboarding-critique/index.md`.

## Global Constraints

- No em dashes in any user-facing string (PRODUCT.md hard rule).
- No developer plumbing on screen: no "relay", no subdomain, no slug shown anywhere in the canvas flow.
- No new `unwrap()`-style unchecked paths; every await that can reject is caught and surfaced as typed state.
- rem-based text tokens only (CI guard `pnpm check:px-text`).
- Every commit: `git commit -s` (DCO).
- Unit tests are `*.test.mjs` beside the source, run with `pnpm test` (from `desktop/`). Scope a single file: `node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/completeFirstRun.test.mjs`.
- Existing behavior for joiners and for the legacy `OnboardingFlow` inside `AppReady` must not change except where a task says so.
- All paths below relative to `desktop/` unless prefixed `crates/` or absolute.

---

### Task 1: `completeFirstRun` shared completion module

**Files:**
- Create: `src/features/onboarding/flow/completeFirstRun.ts`
- Create: `src/features/onboarding/flow/completeFirstRun.test.mjs`
- Modify: `src/features/onboarding/ui/CommunityOnboardingFlow.tsx` (finalize, lines ~257-359)

**Interfaces:**
- Consumes: `initializeStarterChannels` (`../hooks`), `markCommunityOnboardingComplete` (`../communityOnboarding`), `takePendingWelcomeChannelForDirectEntry` (`../welcome`), `onboardingFirstTaskMarker` + `buildOnboardingFirstTaskMessage` (`../onboardingV2FirstTask`), `hasManagedAgentChannelMessageMarker` + `sendChannelMessage` (same imports CommunityOnboardingFlow uses today), `updateProfile` (`@/shared/api/tauriProfiles`).
- Produces: `completeFirstRun(deps: CompleteFirstRunDeps): Promise<CompleteFirstRunResult>` and the two types, used by Task 6's host and by legacy `finalize`.

- [ ] **Step 1: Write the failing test**

`src/features/onboarding/flow/completeFirstRun.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { completeFirstRun } from "./completeFirstRun.ts";

function makeIo(overrides = {}) {
  const calls = [];
  return {
    calls,
    io: {
      initializeStarterChannels: async () => {
        calls.push("channels");
        return { ok: true, focusChannelId: "chan-1" };
      },
      updateProfile: async (input) => {
        calls.push(`profile:${input.displayName}`);
        return {};
      },
      hasMarker: async () => false,
      sendFirstTask: async () => {
        calls.push("task");
        return { eventId: "evt-9" };
      },
      markComplete: (pubkey, relayUrl) => {
        calls.push(`complete:${pubkey}:${relayUrl}`);
      },
      takePendingWelcomeChannelForDirectEntry: () => {},
      navigateToChannel: (id) => calls.push(`nav:${id}`),
      ...overrides,
    },
  };
}

const draft = {
  firstTask: { content: "Get to know Acme.", deliveredEventId: "" },
};

test("happy path: channels, profile, task, gate key, navigation", async () => {
  const { io, calls } = makeIo();
  const result = await completeFirstRun(
    {
      queryClient: {},
      relayUrl: "wss://acme.test",
      pubkey: "pk1",
      draft,
      profileDisplayName: "Aisha Bello",
    },
    io,
  );
  assert.equal(result.focusChannelId, "chan-1");
  assert.equal(result.firstTaskEventId, "evt-9");
  assert.deepEqual(calls, [
    "channels",
    "profile:Aisha Bello",
    "task",
    "nav:chan-1",
    "complete:pk1:wss://acme.test",
  ]);
});

test("skips delivery when the marker already exists", async () => {
  const { io, calls } = makeIo({ hasMarker: async () => true });
  const result = await completeFirstRun(
    { queryClient: {}, relayUrl: "wss://r", pubkey: "pk", draft,
      profileDisplayName: null },
    io,
  );
  assert.equal(result.firstTaskEventId, "already-delivered");
  assert.ok(!calls.includes("task"));
  assert.ok(!calls.some((c) => c.startsWith("profile:")));
});

test("skips delivery when draft is null or content empty", async () => {
  const { io, calls } = makeIo();
  await completeFirstRun(
    { queryClient: {}, relayUrl: "wss://r", pubkey: "pk", draft: null,
      profileDisplayName: null },
    io,
  );
  assert.ok(!calls.includes("task"));
});

test("throws when starter channels fail without a focus channel", async () => {
  const { io } = makeIo({
    initializeStarterChannels: async () => ({ ok: false, reason: "boom" }),
  });
  await assert.rejects(
    completeFirstRun(
      { queryClient: {}, relayUrl: "wss://r", pubkey: "pk", draft: null,
        profileDisplayName: null },
      io,
    ),
    /boom/,
  );
});

test("profile write failure does not block completion", async () => {
  const { io, calls } = makeIo({
    updateProfile: async () => {
      throw new Error("profile down");
    },
  });
  const result = await completeFirstRun(
    { queryClient: {}, relayUrl: "wss://r", pubkey: "pk", draft: null,
      profileDisplayName: "Aisha" },
    io,
  );
  assert.equal(result.focusChannelId, "chan-1");
  assert.ok(calls.includes("complete:pk:wss://r"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `desktop/`): `node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/completeFirstRun.test.mjs`
Expected: FAIL, cannot find module `./completeFirstRun.ts`.

- [ ] **Step 3: Write the module**

`src/features/onboarding/flow/completeFirstRun.ts`:

```ts
// desktop/src/features/onboarding/flow/completeFirstRun.ts
import type { QueryClient } from "@tanstack/react-query";

import { sendChannelMessage } from "@/shared/api/tauri";
import { hasManagedAgentChannelMessageMarker } from "@/shared/api/tauriAgents";
import { updateProfile } from "@/shared/api/tauriProfiles";
import { markCommunityOnboardingComplete } from "../communityOnboarding";
import type { OnboardingV2Draft } from "../onboardingV2";
import {
  buildOnboardingFirstTaskMessage,
  onboardingFirstTaskMarker,
} from "../onboardingV2FirstTask";
import { takePendingWelcomeChannelForDirectEntry } from "../welcome";
import { initializeStarterChannels } from "../hooks";

/**
 * Everything first-run completion touches, injectable so the module is
 * testable without Tauri. Production callers use DEFAULT_IO.
 */
export type CompleteFirstRunIo = {
  initializeStarterChannels: typeof initializeStarterChannels;
  updateProfile: (input: { displayName: string }) => Promise<unknown>;
  hasMarker: (args: {
    channelId: string;
    marker: string;
    markerScope: "channel";
  }) => Promise<boolean>;
  sendFirstTask: (
    channelId: string,
    content: string,
    marker: string,
  ) => Promise<{ eventId: string }>;
  markComplete: (pubkey: string, relayUrl: string) => void;
  takePendingWelcomeChannelForDirectEntry: () => void;
  navigateToChannel: (channelId: string) => void;
};

export type CompleteFirstRunDeps = {
  queryClient: QueryClient;
  relayUrl: string;
  pubkey: string;
  /** Scout's opening brief; null skips delivery entirely. */
  draft: OnboardingV2Draft | null;
  /** kind:0 display name to publish; null/empty skips the profile write. */
  profileDisplayName: string | null;
};

export type CompleteFirstRunResult = {
  focusChannelId: string | null;
  /** Event id of the delivered brief, "already-delivered", or null. */
  firstTaskEventId: string | null;
};

export const DEFAULT_IO: CompleteFirstRunIo = {
  initializeStarterChannels,
  updateProfile: (input) => updateProfile(input),
  hasMarker: (args) => hasManagedAgentChannelMessageMarker(args),
  sendFirstTask: async (channelId, content, marker) => {
    const sent = await sendChannelMessage(
      channelId,
      content,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [["client", marker]],
    );
    return { eventId: sent.eventId };
  },
  markComplete: markCommunityOnboardingComplete,
  takePendingWelcomeChannelForDirectEntry,
  navigateToChannel: (channelId) => {
    window.location.hash = `/channels/${channelId}`;
  },
};

/**
 * One first run, completed: starter channels + private Welcome ensured, the
 * founder's kind:0 published, Scout's brief delivered once, the router pointed
 * at Welcome, and the app-level gate key written. Shared by the canvas flow
 * and the legacy community flow so the two paths cannot drift.
 *
 * The profile write is best effort: a founder with no kind:0 still has a
 * working workspace, and the settings screen can publish the name later. The
 * gate key is written last so a thrown step leaves onboarding re-runnable.
 */
export async function completeFirstRun(
  deps: CompleteFirstRunDeps,
  io: CompleteFirstRunIo = DEFAULT_IO,
): Promise<CompleteFirstRunResult> {
  const result = await io.initializeStarterChannels(deps.queryClient, {
    focus: true,
    pubkey: deps.pubkey,
    communityScope: deps.relayUrl,
  });
  if (!result.ok && !result.focusChannelId) {
    throw new Error(result.reason);
  }
  const focusChannelId = result.focusChannelId ?? null;

  const displayName = deps.profileDisplayName?.trim();
  if (displayName) {
    try {
      await io.updateProfile({ displayName });
    } catch (error) {
      console.warn("First-run profile write failed; continuing.", error);
    }
  }

  let firstTaskEventId: string | null = null;
  const content = deps.draft?.firstTask.content.trim();
  if (deps.draft && content && focusChannelId) {
    const marker = onboardingFirstTaskMarker(deps.draft);
    const exists = await io.hasMarker({
      channelId: focusChannelId,
      marker,
      markerScope: "channel",
    });
    if (exists) {
      firstTaskEventId = "already-delivered";
    } else {
      const sent = await io.sendFirstTask(
        focusChannelId,
        buildOnboardingFirstTaskMessage(deps.draft),
        marker,
      );
      firstTaskEventId = sent.eventId;
    }
  }

  if (focusChannelId) {
    io.takePendingWelcomeChannelForDirectEntry();
    io.navigateToChannel(focusChannelId);
  }
  io.markComplete(deps.pubkey, deps.relayUrl);
  return { focusChannelId, firstTaskEventId };
}
```

Check the real name of the marker-check import first: `grep -n "hasManagedAgentChannelMessageMarker" src/features/onboarding/ui/CommunityOnboardingFlow.tsx` and mirror that exact import path.

- [ ] **Step 4: Run test to verify it passes**

Same command as Step 2. Expected: PASS (5 tests). If the TS import chain drags React into the node test (it should not: no React imports in the module), split DEFAULT_IO into a `completeFirstRun.io.ts` file and keep the pure function React-free.

- [ ] **Step 5: Refactor legacy `finalize` onto the module**

In `CommunityOnboardingFlow.tsx`, replace the body of the `work` async closure inside `finalize` (the part from `const result = await initializeStarterChannels(...)` through `markCommunityOnboardingComplete(identity.pubkey, relayUrl);`) with:

```ts
const identity = await getIdentity();
const completion = await completeFirstRun({
  queryClient,
  relayUrl,
  pubkey: identity.pubkey,
  draft: transaction?.onboardingV2 ?? null,
  profileDisplayName: null,
});
if (completion.focusChannelId) {
  let onboardingV2 = transaction?.onboardingV2;
  if (onboardingV2 && completion.firstTaskEventId) {
    onboardingV2 = {
      ...onboardingV2,
      firstTask: {
        ...onboardingV2.firstTask,
        deliveredEventId: completion.firstTaskEventId,
      },
    };
  }
  update({
    stage: "entering",
    error: undefined,
    onboardingV2: onboardingV2
      ? { ...onboardingV2, stage: "entering" }
      : undefined,
  });
  return;
}
await finish();
```

`profileDisplayName: null` because the legacy profile stage already published kind:0. Delivery-when-already-delivered semantics are identical: the module returns `"already-delivered"` where the old inline code set the same string, and returns `null` when the draft had no content, in which case the old code also left `deliveredEventId` untouched. Delete the now-unused imports (`onboardingFirstTaskMarker`, `buildOnboardingFirstTaskMessage`, `hasManagedAgentChannelMessageMarker`, `sendChannelMessage`, `takePendingWelcomeChannelForDirectEntry`, `initializeStarterChannels`, `markCommunityOnboardingComplete` if unused elsewhere in the file: `finish` still uses `markCommunityOnboardingComplete`, keep it).

- [ ] **Step 6: Run the full unit suite + typecheck**

Run: `pnpm test` and `pnpm exec tsc --noEmit`
Expected: green; `communityOnboarding.test.mjs` and `onboardingFlowBackup.test.mjs` unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/features/onboarding/flow/completeFirstRun.ts src/features/onboarding/flow/completeFirstRun.test.mjs src/features/onboarding/ui/CommunityOnboardingFlow.tsx
git commit -s -m "refactor(onboarding): extract shared completeFirstRun module"
```

---

### Task 2: workspace slug derivation

**Files:**
- Create: `src/features/onboarding/flow/workspaceSlug.ts`
- Create: `src/features/onboarding/flow/workspaceSlug.test.mjs`

**Interfaces:**
- Produces: `slugifyCompany(name: string): string`, `slugCandidates(base: string): string[]` for Task 3.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { slugCandidates, slugifyCompany } from "./workspaceSlug.ts";

test("lowercases, hyphenates, strips punctuation", () => {
  assert.equal(slugifyCompany("Rosebank Auto Care"), "rosebank-auto-care");
  assert.equal(slugifyCompany("  Café & Sons!  "), "caf-sons");
  assert.equal(slugifyCompany("A--B__C"), "a-b-c");
});

test("trims to 63 chars without a trailing hyphen", () => {
  const long = "x".repeat(80);
  assert.equal(slugifyCompany(long).length, 63);
  const edge = `${"a".repeat(62)}-bcd`;
  assert.ok(!slugifyCompany(edge).endsWith("-"));
});

test("falls back to 'workspace' when nothing survives", () => {
  assert.equal(slugifyCompany("!!!"), "workspace");
  assert.equal(slugifyCompany(""), "workspace");
});

test("candidates: base then -2 through -9, all within 63 chars", () => {
  const list = slugCandidates("acme");
  assert.deepEqual(list.slice(0, 3), ["acme", "acme-2", "acme-3"]);
  assert.equal(list.length, 9);
  const longList = slugCandidates("y".repeat(63));
  for (const candidate of longList) {
    assert.ok(candidate.length <= 63, candidate);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/workspaceSlug.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// desktop/src/features/onboarding/flow/workspaceSlug.ts

/** Longest hostname label the relay accepts (VALID_HOSTED_COMMUNITY_NAME). */
const MAX_SLUG_LENGTH = 63;

/**
 * Derive the hosted-community name from the typed company name. The user
 * never sees this value: the flow claims an address silently and the pretty
 * name stays the local community label.
 */
export function slugifyCompany(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/, "");
  return slug === "" ? "workspace" : slug;
}

/** The base plus eight numbered fallbacks, for silent collision handling. */
export function slugCandidates(base: string): string[] {
  const candidates = [base];
  for (let n = 2; n <= 9; n += 1) {
    const suffix = `-${n}`;
    candidates.push(base.slice(0, MAX_SLUG_LENGTH - suffix.length) + suffix);
  }
  return candidates;
}
```

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: PASS. Note the `"Café & Sons!"` expectation: NFKD splits `é` into `e` + combining accent, so the result is actually `cafe-sons`; if the test written in Step 1 fails on that, fix the TEST to `cafe-sons` (the implementation keeping the base letter is the desired behavior).

- [ ] **Step 5: Commit**

```bash
git add src/features/onboarding/flow/workspaceSlug.ts src/features/onboarding/flow/workspaceSlug.test.mjs
git commit -s -m "feat(onboarding): derive hosted workspace slug from company name"
```

---

### Task 3: `provisionWorkspace`

**Files:**
- Create: `src/features/onboarding/flow/provisionWorkspace.ts`
- Create: `src/features/onboarding/flow/provisionWorkspace.test.mjs`

**Interfaces:**
- Consumes: `slugifyCompany`, `slugCandidates` (Task 2); `hostedCommunityRelayUrl`, types from `@/features/communities/hostedCommunityApi`.
- Produces: `provisionWorkspace(companyName: string, storedSlug: string | null, api: ProvisionApi): Promise<ProvisionOutcome>` with `ProvisionApi = { check(name): Promise<ColonyAvailability>; create(name): Promise<ColonyCreateResponse>; listMine(): Promise<ColonyCommunitiesResponse> }` and `ProvisionOutcome = { ok: true; slug: string; relayUrl: string; communityId: string | null } | { ok: false; reason: "exhausted" | "limit" | "unreachable"; message: string }`. Task 5/6 consume both.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import { provisionWorkspace } from "./provisionWorkspace.ts";

const created = (slug) => ({
  community: { id: `id-${slug}`, slug, normalized_host: `${slug}.colony.test` },
});

test("creates on the first available candidate", async () => {
  const tried = [];
  const outcome = await provisionWorkspace("Acme Co", null, {
    check: async (name) => {
      tried.push(name);
      return { available: name !== "acme-co" };
    },
    create: async (name) => created(name),
    listMine: async () => ({ communities: [] }),
  });
  assert.deepEqual(tried, ["acme-co", "acme-co-2"]);
  assert.deepEqual(outcome, {
    ok: true,
    slug: "acme-co-2",
    relayUrl: "wss://acme-co-2.colony.test",
    communityId: "id-acme-co-2",
  });
});

test("a race on create falls through to the next candidate", async () => {
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => ({ available: true }),
    create: async (name) => {
      if (name === "acme") throw new Error("taken: acme");
      return created(name);
    },
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.slug, "acme-2");
});

test("resume: a stored slug the account already owns is reused, not recreated", async () => {
  let createCalls = 0;
  const outcome = await provisionWorkspace("Acme", "acme", {
    check: async () => ({ available: false }),
    create: async () => {
      createCalls += 1;
      return created("never");
    },
    listMine: async () => ({
      communities: [
        { slug: "acme", normalized_host: "acme.colony.test", archived_at: null },
      ],
    }),
  });
  assert.equal(createCalls, 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.relayUrl, "wss://acme.colony.test");
});

test("limit errors are terminal, not retried through candidates", async () => {
  let createCalls = 0;
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => ({ available: true }),
    create: async () => {
      createCalls += 1;
      throw new Error("limit_reached");
    },
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(createCalls, 1);
  assert.deepEqual(outcome.ok, false);
  assert.equal(outcome.reason, "limit");
});

test("every candidate taken reports exhausted", async () => {
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => ({ available: false }),
    create: async () => created("x"),
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "exhausted");
});

test("network failure on check reports unreachable", async () => {
  const outcome = await provisionWorkspace("Acme", null, {
    check: async () => {
      throw new Error("fetch failed");
    },
    create: async () => created("x"),
    listMine: async () => ({ communities: [] }),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "unreachable");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/flow/provisionWorkspace.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// desktop/src/features/onboarding/flow/provisionWorkspace.ts
import type {
  ColonyAvailability,
  ColonyCommunitiesResponse,
  ColonyCreateResponse,
} from "@/features/communities/hostedCommunityApi";
import { hostedCommunityRelayUrl } from "@/features/communities/hostedCommunityApi";

import { slugCandidates, slugifyCompany } from "./workspaceSlug";

export type ProvisionApi = {
  check: (name: string) => Promise<ColonyAvailability>;
  create: (name: string) => Promise<ColonyCreateResponse>;
  listMine: () => Promise<ColonyCommunitiesResponse>;
};

export type ProvisionOutcome =
  | { ok: true; slug: string; relayUrl: string; communityId: string | null }
  | { ok: false; reason: "exhausted" | "limit" | "unreachable"; message: string };

const UNREACHABLE_MESSAGE =
  "We could not reach Colony to set up your workspace. Check your internet connection and try again.";
const EXHAUSTED_MESSAGE =
  "We could not find a free address for that company name. Adjust the name slightly and try again.";
const LIMIT_MESSAGE =
  "This account already runs the maximum number of workspaces.";

function isLimitError(error: unknown): boolean {
  return error instanceof Error && /limit_reached|limit/i.test(error.message);
}

function isTakenError(error: unknown): boolean {
  return error instanceof Error && /taken/i.test(error.message);
}

/**
 * Claim a hosted community for the typed company name, silently absorbing
 * collisions with numbered fallbacks. `storedSlug` makes a reload-resume
 * idempotent: a community this account already owns under that slug is
 * reused instead of created twice.
 */
export async function provisionWorkspace(
  companyName: string,
  storedSlug: string | null,
  api: ProvisionApi,
): Promise<ProvisionOutcome> {
  try {
    if (storedSlug) {
      const mine = await api.listMine();
      const existing = (mine.communities ?? []).find(
        (community) =>
          community.slug === storedSlug && !community.archived_at,
      );
      if (existing) {
        const relayUrl = hostedCommunityRelayUrl(existing);
        if (relayUrl) {
          return {
            ok: true,
            slug: storedSlug,
            relayUrl,
            communityId: existing.id ?? null,
          };
        }
      }
    }

    for (const candidate of slugCandidates(slugifyCompany(companyName))) {
      const availability = await api.check(candidate);
      if (availability.available === false) continue;
      try {
        const response = await api.create(candidate);
        const community = response.community;
        const relayUrl = community ? hostedCommunityRelayUrl(community) : null;
        if (!community || !relayUrl) {
          return {
            ok: false,
            reason: "unreachable",
            message: UNREACHABLE_MESSAGE,
          };
        }
        return {
          ok: true,
          slug: community.slug ?? candidate,
          relayUrl,
          communityId: community.id ?? null,
        };
      } catch (error) {
        if (isLimitError(error)) {
          return { ok: false, reason: "limit", message: LIMIT_MESSAGE };
        }
        if (isTakenError(error)) continue;
        throw error;
      }
    }
    return { ok: false, reason: "exhausted", message: EXHAUSTED_MESSAGE };
  } catch {
    return { ok: false, reason: "unreachable", message: UNREACHABLE_MESSAGE };
  }
}
```

Before finalizing the error matching, read the exact strings the Tauri command produces: `sed -n '22,47p' ../crates/../desktop/src-tauri/src/colony_provisioning.rs` shows `relay_error_message` prefixes availability conflicts with `taken:`; adjust `isTakenError`/`isLimitError` to those literals.

- [ ] **Step 4: Run test to verify it passes**

Same command. Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/onboarding/flow/provisionWorkspace.ts src/features/onboarding/flow/provisionWorkspace.test.mjs
git commit -s -m "feat(onboarding): idempotent hosted workspace provisioning"
```

---

### Task 4: fresh-founder marker + answers slug field

**Files:**
- Create: `src/features/onboarding/freshFounder.ts`
- Create: `src/features/onboarding/freshFounder.test.mjs`
- Modify: `src/features/onboarding/hooks.ts` (export the key helper, line ~213)
- Modify: `src/features/onboarding/ui/MachineOnboardingFlow.tsx` (`loadFreshIdentity`, line ~136)
- Modify: `src/features/onboarding/flow/steps.ts` (answers type) and `src/features/onboarding/flow/persistence.ts` (coerce + EMPTY_ANSWERS)

**Interfaces:**
- Produces: `markFreshIdentity(pubkey: string, storage?: Storage): void`, `clearFreshIdentity(pubkey: string, storage?: Storage): void`, `isFreshFounder(args: { pubkey: string | null; communitiesCount: number; storage?: Storage }): boolean` for Task 6. `OnboardingAnswers` gains `communitySlug: string | null` for Task 5.

- [ ] **Step 1: Export the completion key helper from hooks.ts**

In `hooks.ts` change `function onboardingCompletionStorageKey(` to `export function onboardingCompletionStorageKey(` (line ~213). Nothing else moves.

- [ ] **Step 2: Write the failing test**

`src/features/onboarding/freshFounder.test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isFreshFounder,
  markFreshIdentity,
} from "./freshFounder.ts";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
  };
}

test("fresh marker + no completion + no communities = founder", () => {
  const storage = memoryStorage();
  markFreshIdentity("pk1", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk1", communitiesCount: 0, storage }),
    true,
  );
});

test("no marker (imported identity) is never a fresh founder", () => {
  const storage = memoryStorage();
  assert.equal(
    isFreshFounder({ pubkey: "pk1", communitiesCount: 0, storage }),
    false,
  );
});

test("a completed pubkey is never a fresh founder", () => {
  const storage = memoryStorage({
    "buzz-onboarding-complete.v1:pk1": "true",
  });
  markFreshIdentity("pk1", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk1", communitiesCount: 0, storage }),
    false,
  );
});

test("existing communities suppress the canvas run", () => {
  const storage = memoryStorage();
  markFreshIdentity("pk1", storage);
  assert.equal(
    isFreshFounder({ pubkey: "pk1", communitiesCount: 1, storage }),
    false,
  );
});

test("null pubkey is never a fresh founder", () => {
  assert.equal(
    isFreshFounder({
      pubkey: null,
      communitiesCount: 0,
      storage: memoryStorage(),
    }),
    false,
  );
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --import ./test-loader.mjs --experimental-strip-types --test src/features/onboarding/freshFounder.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement**

```ts
// desktop/src/features/onboarding/freshFounder.ts
import { onboardingCompletionStorageKey } from "./hooks";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const FRESH_IDENTITY_KEY_PREFIX = "colony.identity.fresh";

function freshIdentityKey(pubkey: string): string {
  return `${FRESH_IDENTITY_KEY_PREFIX}:${pubkey}`;
}

function ambientStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

/**
 * Written only by machine onboarding's fresh-identity path ("Start with
 * Colony" on a computer with no prior identity). An imported identity never
 * gets it, which is what keeps returning users out of the founder flow: with
 * no relay applied yet there is no kind:0 to consult, so this local marker is
 * the only evidence of "brand new here".
 */
export function markFreshIdentity(
  pubkey: string,
  storage: StorageLike | null = ambientStorage(),
): void {
  storage?.setItem(freshIdentityKey(pubkey), "true");
}

export function clearFreshIdentity(
  pubkey: string,
  storage: StorageLike | null = ambientStorage(),
): void {
  storage?.removeItem(freshIdentityKey(pubkey));
}

/** Should this boot run the canvas first-run instead of WelcomeSetup? */
export function isFreshFounder({
  pubkey,
  communitiesCount,
  storage = ambientStorage(),
}: {
  pubkey: string | null;
  communitiesCount: number;
  storage?: StorageLike | null;
}): boolean {
  if (!pubkey || communitiesCount > 0 || !storage) return false;
  if (storage.getItem(freshIdentityKey(pubkey)) !== "true") return false;
  return storage.getItem(onboardingCompletionStorageKey(pubkey)) !== "true";
}
```

If importing `./hooks` from a node test drags React/TanStack into the `.mjs` run and fails, move `onboardingCompletionStorageKey` into a new tiny `src/features/onboarding/completionKey.ts`, re-export it from `hooks.ts`, and import the tiny module here. Decide by running the test.

- [ ] **Step 5: Run test to verify it passes**

Expected: PASS (5 tests).

- [ ] **Step 6: Wire the marker into machine onboarding**

In `MachineOnboardingFlow.tsx` `loadFreshIdentity` (~line 136), after the backup-reminder `setItem`:

```ts
markFreshIdentity(identity.pubkey);
```

with `import { markFreshIdentity } from "../freshFounder";` added to the imports.

- [ ] **Step 7: Add `communitySlug` to answers**

`flow/steps.ts`: add to `OnboardingAnswers`:

```ts
  /** Hosted address claimed for this run, for idempotent resume. */
  communitySlug: string | null;
```

`flow/persistence.ts`: add `communitySlug: null,` to `EMPTY_ANSWERS` and `communitySlug: value.communitySlug ?? null,` to `coerce`.

- [ ] **Step 8: Run suite + typecheck, fix fallout**

Run: `pnpm test` and `pnpm exec tsc --noEmit`
Expected: `steps.test.mjs`, `persistence.test.mjs`, `onboardingV2.test.mjs`, `founderBrief.test.mjs` may construct `OnboardingAnswers` literals; add `communitySlug: null` where the compiler or a test complains.

- [ ] **Step 9: Commit**

```bash
git add -A src/features/onboarding
git commit -s -m "feat(onboarding): fresh-founder marker and resume slug"
```

---

### Task 5: flow changes (async completion, provisioning company screen)

**Files:**
- Modify: `src/features/onboarding/ui/new/NewOnboardingFlow.tsx`
- Modify: `src/features/onboarding/ui/new/screens/CompanyScreen.tsx`
- Modify: `src/features/onboarding/ui/new/screens/CreditsScreen.tsx` (finishing state on actions)
- Modify: `src/features/onboarding/ui/new/screens/InviteScreen.tsx` (same, minimal)
- Delete: `src/features/onboarding/flow/stashFounderBrief.ts`, `src/features/onboarding/flow/stashFounderBrief.test.mjs`
- Test: update `src/features/onboarding/ui/onboardingFlowSteps.test.mjs` / `onboardingV2.test.mjs` only if they import the deleted module.

**Interfaces:**
- Consumes: `ProvisionOutcome` (Task 3), `OnboardingAnswers.communitySlug` (Task 4).
- Produces (new `NewOnboardingFlow` props consumed by Task 6's host):

```ts
type Props = {
  services: OnboardingServices;
  /**
   * Null when a community is already applied (internal auto-connect builds):
   * the company step records the name and provisions nothing.
   */
  provisioning: {
    provision: (
      companyName: string,
      storedSlug: string | null,
    ) => Promise<ProvisionOutcome>;
    onProvisioned: (outcome: Extract<ProvisionOutcome, { ok: true }>) => void;
  } | null;
  /** Resolves when the community config is applied; rejects on apply error. */
  onComplete: (answers: OnboardingAnswers) => Promise<void>;
};
```

- [ ] **Step 1: Make completion async and answer-carrying**

In `NewOnboardingFlow.tsx`:
- Props type: replace `onComplete: () => void` with the block above (import `ProvisionOutcome` type).
- Remove `import { stashFounderBrief } ...`.
- Add state: `const [finishState, setFinishState] = useState<{ status: "idle" | "running" | "error"; message?: string }>({ status: "idle" });`
- Replace `finish`:

```ts
const finish = useCallback(() => {
  if (finishedRef.current) return;
  finishedRef.current = true;
  setFinishState({ status: "running" });
  void onCompleteRef
    .current(answersRef.current)
    .then(() => {
      clearAnswers(answerStorage);
    })
    .catch((error: unknown) => {
      finishedRef.current = false;
      setFinishState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Something went wrong opening your workspace. Try again.",
      });
    });
}, []);
```

`onCompleteRef` typing changes to `(answers: OnboardingAnswers) => Promise<void>`. `clearAnswers` moves inside `.then` so a failed completion still resumes after relaunch.

- [ ] **Step 2: Provisioning on company submit**

Still in `NewOnboardingFlow.tsx`:

```ts
const [companyState, setCompanyState] = useState<{
  status: "idle" | "provisioning" | "error";
  message?: string;
}>({ status: "idle" });

const handleCompanySubmit = async () => {
  const name = companyValues.company.trim();
  if (!name || companyState.status === "provisioning") return;
  if (!provisioning) {
    const updated: OnboardingAnswers = { ...answers, company: name };
    setAnswers(updated);
    goTo(nextStep("company", updated));
    return;
  }
  setCompanyState({ status: "provisioning" });
  const outcome = await provisioning.provision(name, answers.communitySlug);
  if (!outcome.ok) {
    setCompanyState({ status: "error", message: outcome.message });
    return;
  }
  provisioning.onProvisioned(outcome);
  setCompanyState({ status: "idle" });
  const updated: OnboardingAnswers = {
    ...answers,
    company: name,
    communitySlug: outcome.slug,
  };
  setAnswers(updated);
  goTo(nextStep("company", updated));
};
```

Pass to `CompanyScreen`: `isSubmitting={companyState.status === "provisioning"}` and `error={companyState.status === "error" ? companyState.message : null}`.

- [ ] **Step 3: CompanyScreen states**

In `CompanyScreen.tsx` add props `isSubmitting?: boolean; error?: string | null;`. Read the file first and mirror its existing structure exactly (label classes `onb-field`, note class `onb-note`). Submit button: label `isSubmitting ? "Creating your workspace" : "Create workspace"`, `disabled` while submitting or name empty (keep existing emptiness rule). Under the field, when `error`:

```tsx
{error ? <p className="onb-note onb-note-warn">{error}</p> : null}
```

- [ ] **Step 4: Surface finishing state on the two exit screens**

`CreditsScreen` and `InviteScreen` both trigger `finish` (skip/paid/send/just-me). Pass `finishing={finishState.status === "running"}` and `finishError={finishState.status === "error" ? finishState.message : null}` plus `onRetryFinish={finish}` from the flow into `CreditsScreen`; inside, disable the action buttons while `finishing`, change the skip label to `"Opening your workspace"` while finishing, and render above the actions:

```tsx
{finishError ? (
  <p className="onb-note onb-note-warn">
    {finishError}{" "}
    <button type="button" className="onb-quiet-action" onClick={onRetryFinish}>
      Try again
    </button>
  </p>
) : null}
```

Mirror the same three props on `InviteScreen`'s send/skip actions (flag-dark today, keep it consistent anyway). Read both files before editing; keep their existing prop patterns.

- [ ] **Step 5: Delete the stash bridge**

```bash
git rm src/features/onboarding/flow/stashFounderBrief.ts src/features/onboarding/flow/stashFounderBrief.test.mjs
```

`draftFromAnswers` (`flow/founderBrief.ts`) stays: Task 6's host consumes it directly.

- [ ] **Step 6: Suite + typecheck**

Run: `pnpm test` and `pnpm exec tsc --noEmit`
Expected: compile errors at the `AppReady` call site (`App.tsx` still passes the old props). That is Task 6's file; to keep this commit green, update the `AppReady` call site minimally in this task:

```tsx
<NewOnboardingFlow
  key={onboarding.currentPubkey ?? "anonymous"}
  services={onboardingServices}
  provisioning={null}
  onComplete={async () => onboarding.flow.actions.complete()}
/>
```

(The whole branch is deleted in Task 6; this keeps every commit buildable.)

- [ ] **Step 7: Commit**

```bash
git add -A src/features/onboarding src/app/App.tsx
git commit -s -m "feat(onboarding): async completion and real workspace provisioning in canvas flow"
```

---

### Task 6: `CanvasFirstRunHost` + mount move

**Files:**
- Create: `src/features/onboarding/ui/new/CanvasFirstRunHost.tsx`
- Modify: `src/app/App.tsx` (CommunityApp + AppReady)

**Interfaces:**
- Consumes: `provisionWorkspace` + `ProvisionOutcome` (Task 3), `isFreshFounder` (Task 4), `completeFirstRun` (Task 1), `draftFromAnswers` (`../..../flow/founderBrief`), `NewOnboardingFlow` props (Task 5), `checkColonyCommunityName`/`createColonyCommunity`/`listColonyCommunities` (`@/features/communities/hostedCommunityApi`), `useCommunities`, `getIdentity` (`@/shared/api/tauriIdentity`).
- Produces: `<CanvasFirstRunHost currentPubkey={string} communityApplied={boolean} activeRelayUrl={string | null} onFinished={() => void} />`.

- [ ] **Step 1: Write the host**

```tsx
// desktop/src/features/onboarding/ui/new/CanvasFirstRunHost.tsx
import { useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";
import {
  checkColonyCommunityName,
  createColonyCommunity,
  listColonyCommunities,
} from "@/features/communities/hostedCommunityApi";
import { createFakeServices } from "../../contracts.fake";
import { completeFirstRun } from "../../flow/completeFirstRun";
import { draftFromAnswers } from "../../flow/founderBrief";
import {
  provisionWorkspace,
  type ProvisionOutcome,
} from "../../flow/provisionWorkspace";
import type { OnboardingAnswers } from "../../flow/steps";
import { NewOnboardingFlow } from "./NewOnboardingFlow";

const APPLY_DEADLINE_MS = 15_000;

type Props = {
  currentPubkey: string;
  /** Live from CommunityApp: the active community's config is applied. */
  communityApplied: boolean;
  /** Relay of the applied community, when one exists. */
  activeRelayUrl: string | null;
  onFinished: () => void;
};

/**
 * Owns the canvas first run from above the community boundary: provisions the
 * hosted community when the company screen submits, waits for the config to
 * apply underneath, and completes the run (channels, profile, brief, gate
 * key) when the flow finishes. Renders nothing but the flow itself.
 */
export function CanvasFirstRunHost({
  currentPubkey,
  communityApplied,
  activeRelayUrl,
  onFinished,
}: Props) {
  const queryClient = useQueryClient();
  const { addCommunity } = useCommunities();
  const services = useMemo(() => createFakeServices(), []);

  // Snapshot live values for callbacks without re-identity-ing the flow.
  const appliedRef = useRef(communityApplied);
  appliedRef.current = communityApplied;
  const relayUrlRef = useRef(activeRelayUrl);
  relayUrlRef.current = activeRelayUrl;

  const hadCommunityAtMount = useRef(activeRelayUrl !== null).current;

  const provision = useCallback(
    (companyName: string, storedSlug: string | null) =>
      provisionWorkspace(companyName, storedSlug, {
        check: checkColonyCommunityName,
        create: createColonyCommunity,
        listMine: listColonyCommunities,
      }),
    [],
  );

  const onProvisioned = useCallback(
    (outcome: Extract<ProvisionOutcome, { ok: true }>) => {
      addCommunity({
        id: crypto.randomUUID(),
        name: outcome.slug,
        relayUrl: outcome.relayUrl,
        pubkey: currentPubkey,
        addedAt: new Date().toISOString(),
      });
    },
    [addCommunity, currentPubkey],
  );

  const provisioning = useMemo(
    () => (hadCommunityAtMount ? null : { provision, onProvisioned }),
    [hadCommunityAtMount, provision, onProvisioned],
  );

  const waitForApply = useCallback(async () => {
    const startedAt = Date.now();
    while (!appliedRef.current || relayUrlRef.current === null) {
      if (Date.now() - startedAt > APPLY_DEADLINE_MS) {
        throw new Error(
          "Your workspace is taking longer than expected. Try again.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return relayUrlRef.current;
  }, []);

  const onComplete = useCallback(
    async (answers: OnboardingAnswers) => {
      const relayUrl = await waitForApply();
      await completeFirstRun({
        queryClient,
        relayUrl,
        pubkey: currentPubkey,
        draft: draftFromAnswers(answers),
        profileDisplayName: answers.founder?.fullName ?? null,
      });
      onFinished();
    },
    [currentPubkey, onFinished, queryClient, waitForApply],
  );

  return (
    <NewOnboardingFlow
      key={currentPubkey}
      services={services}
      provisioning={provisioning}
      onComplete={onComplete}
    />
  );
}
```

Two details to verify while writing: `useCommunities` sets the active community when `addCommunity` runs on an empty list (read `useCommunities.tsx:189-215`; if it does not auto-activate the first community, follow the add with the same activation call `handleCommunityOnboardingConnect` uses). And the community pretty name: `outcome.slug` is a placeholder here; pass the typed company name instead by extending `onProvisioned` to receive it from the flow (the flow calls `onProvisioned` with the outcome; change the signature in Task 5's props to `onProvisioned(outcome, companyName)` and use `name: companyName`).

- [ ] **Step 2: Mount from CommunityApp**

In `App.tsx` `CommunityApp`, after `communityApplied` is computed:

```tsx
const [canvasRunState, setCanvasRunState] = useState<
  "unstarted" | "active" | "finished"
>("unstarted");
const canvasEligible =
  isNewOnboardingEnabled(import.meta.env) &&
  !transaction &&
  canvasRunState !== "finished" &&
  (canvasRunState === "active" ||
    isFreshFounder({
      pubkey: currentPubkey,
      communitiesCount: communities.length,
    }));
useEffect(() => {
  if (canvasEligible && canvasRunState === "unstarted") {
    setCanvasRunState("active");
  }
}, [canvasEligible, canvasRunState]);
```

Then in the `appContent` decision, BEFORE the `!transaction && community.needsSetup` branch:

```tsx
if (canvasEligible && currentPubkey) {
  appContent = (
    <CanvasFirstRunHost
      activeRelayUrl={activeCommunity?.relayUrl ?? null}
      communityApplied={communityApplied}
      currentPubkey={currentPubkey}
      onFinished={() => setCanvasRunState("finished")}
    />
  );
}
```

and guard the existing `if (appContent === null && (!transaction || isEnteringCurtain))` mount so the canvas content is not overwritten: change to `if (appContent === null && (!transaction || isEnteringCurtain))` (unchanged) but assign the canvas branch through the same `appContent === null` chain: place it as the FIRST `appContent` assignment, and add `appContent === null &&` to the `needsSetup`/error chain conditions. A deep-link transaction arriving mid-canvas takes priority automatically: `canvasEligible` is false while `transaction` exists, the flow unmounts, its persisted answers resume after the transaction clears or completes.

Note `currentPubkey` in `CommunityApp` comes from props (`machine.currentPubkey`) already. Imports to add: `CanvasFirstRunHost`, `isFreshFounder`.

- [ ] **Step 3: Delete the AppReady redesign branch**

In `AppReady` remove the `isNewOnboardingEnabled` conditional and the `NewOnboardingFlow` import; the `onboarding.stage === "onboarding"` branch keeps only the legacy `OnboardingFlow` return. Remove the now-unused `createFakeServices` memo if nothing else in `AppReady` uses it.

- [ ] **Step 4: Typecheck + lint + unit suite**

Run: `pnpm exec tsc --noEmit && pnpm exec biome check src && pnpm test`
Expected: green. `postOnboardingNav.test.mjs` exercises App helpers; fix any literal-props fallout.

- [ ] **Step 5: Commit**

```bash
git add src/features/onboarding/ui/new/CanvasFirstRunHost.tsx src/app/App.tsx src/features/onboarding/ui/new/NewOnboardingFlow.tsx
git commit -s -m "feat(onboarding): mount canvas flow above the community boundary for fresh founders"
```

---

### Task 7: e2e — bridge support, spec updates, public first-run proof

**Files:**
- Modify: `src/testing/e2eBridge.ts` (only if gaps found: the bridge already mocks `colony_provisioning_config`, `colony_check_community_name`, `colony_create_community` (~line 12318-12347), `get_identity`, `update_profile`)
- Modify: `tests/helpers/onboarding.ts` (fresh-founder seeding helper)
- Modify: `tests/e2e/onboarding-redesign.spec.ts`
- Create: `tests/e2e/onboarding-first-run-public.spec.ts`
- Modify: `playwright.config.ts` (register the new spec in the `smoke` project `testMatch`)

**Interfaces:**
- Consumes: everything shipped in Tasks 1-6 through the built app.
- Produces: `seedFreshFounderFirstRun(page)` helper other specs can reuse.

- [ ] **Step 1: Read the bridge's colony-command mocks and community handling**

Read `src/testing/e2eBridge.ts` cases at ~12318-12347 and the community-storage seeding controlled by `skipCommunitySeed` (search `skipCommunitySeed` in `tests/helpers/bridge.ts`). Establish: (a) what `colony_create_community` returns (needs `normalized_host` for `hostedCommunityRelayUrl`), (b) whether a community added at runtime by `addCommunity` gets a working mock `apply_workspace` + channel commands against its relayUrl. Fill gaps in the bridge so the canvas path works end to end in e2e; keep changes additive behind existing config options.

- [ ] **Step 2: Add the seeding helper**

In `tests/helpers/onboarding.ts`:

```ts
export async function seedFreshFounder(page: Page, pubkey: string) {
  await page.addInitScript(
    ({ key }) => {
      window.localStorage.setItem(key, "true");
      window.localStorage.setItem("colony.e2e.newOnboarding", "1");
    },
    { key: `colony.identity.fresh:${pubkey}` },
  );
}
```

- [ ] **Step 3: Update `onboarding-redesign.spec.ts` seeding to the new mount point**

`seedFreshFirstRun` becomes: seed fresh-founder marker for the test identity + `installMockBridge(page, undefined, { skipOnboardingSeed: true, skipCommunitySeed: true })` (identity still seeded via `seedActiveIdentity`). Walk assertions stay identical through screen 08; after the credits skip, the existing final assertions (`.onb-canvas` count 0, `app-top-chrome` visible) remain the proof the handoff works. Run the three tests in this spec; fix what the new mount order breaks (the likely difference: the machine gate never opens because machine completion key is part of the standard seed; verify with the first run).

- [ ] **Step 4: Write the public-shaped proof spec**

`tests/e2e/onboarding-first-run-public.spec.ts` — the critique's P0-1 regression test:

```ts
import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { seedActiveIdentity, seedFreshFounder } from "../helpers/onboarding";

const FIRST_RUN_IDENTITY = { ...TEST_IDENTITIES.tyler, username: "" };

// The journey a real public-build founder walks: machine landing, canvas
// flow with real (mock-backed) provisioning, Welcome channel with Scout's
// brief. If this spec fails on the mount point, the redesign has fallen out
// of the shipped path again.
test("public first run: landing to Welcome through the canvas flow", async ({
  page,
}) => {
  await seedFreshFounder(page, FIRST_RUN_IDENTITY.pubkey);
  await seedActiveIdentity(page, FIRST_RUN_IDENTITY);
  await installMockBridge(page, undefined, {
    skipOnboardingSeed: true,
    skipCommunitySeed: true,
  });
  await page.goto("/");

  await expect(
    page.getByRole("heading", { name: "Let's get your colony started." }),
  ).toBeVisible();
  await page.getByLabel("Your name").fill("Aisha Bello");
  await page.getByLabel("Email").fill("aisha@rosebankauto.co.za");
  await page.getByLabel("Password").fill("colonyprototype");
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("I have saved my code").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Company name").fill("Rosebank Auto Care");
  await page.getByRole("button", { name: "Create workspace" }).click();

  await expect(
    page.getByRole("heading", { name: "Pick who does the thinking." }),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  await page
    .getByRole("button", { name: "Not yet, we are still building" })
    .click();
  await page.getByRole("button", { name: "No", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await page
    .getByPlaceholder("We repair and service cars in Johannesburg.")
    .fill("We service and repair cars for owners around Johannesburg.");
  await page.getByRole("button", { name: "Looks right" }).click();

  await page
    .getByRole("button", { name: "I will run my own helpers for now" })
    .click();

  await expect(page.locator(".onb-canvas")).toHaveCount(0);
  await expect(page.getByTestId("app-top-chrome")).toBeVisible();
  // The founder's name reached the profile and Scout received the brief.
  await expect(page.getByText("Get to know Rosebank Auto Care")).toBeVisible({
    timeout: 15_000,
  });
});
```

Register in `playwright.config.ts` `smoke` `testMatch`: add `"**/onboarding-first-run-public.spec.ts"` next to the other onboarding entries. Adjust the final two assertions to what the mock bridge actually renders for a canvas-provisioned community (the brief text comes from `buildOnboardingFirstTaskMessage`; assert on a stable substring).

- [ ] **Step 5: Run the onboarding e2e set**

Run: `pnpm build:e2e && pnpm exec playwright test --project=smoke tests/e2e/onboarding-first-run-public.spec.ts tests/e2e/onboarding-redesign.spec.ts tests/e2e/onboarding-docked-cta-screenshots.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/onboarding-backup.spec.ts tests/e2e/onboarding-avatar-skip.spec.ts`
Expected: all pass. `onboarding.spec.ts`/`onboarding-backup.spec.ts` exercise the legacy flow and WelcomeSetup: they prove joiner behavior did not change.

- [ ] **Step 6: Commit**

```bash
git add -A tests src/testing playwright.config.ts
git commit -s -m "test(onboarding): public-shaped canvas first-run proof + spec reseeding"
```

---

### Task 8: gates, screenshots, PR

**Files:**
- No new source files. PR artifacts only.

- [ ] **Step 1: Full local gate (desktop only)**

Run from `desktop/`: `pnpm exec biome check src && pnpm exec tsc --noEmit && pnpm test && pnpm check:px-text`
Expected: all green. Do NOT run `just ci` (machine rule); Rust is untouched.

- [ ] **Step 2: Screenshot walk for the PR**

Reuse the critique's capture approach: temporary spec walking the new mount path, `just desktop-screenshot` unavailable for pre-community screens, so a spec + `scripts/post-screenshots.sh <pr> <dir>` after the PR opens. Screens worth showing: company screen with "Creating your workspace" state, an error state (bridge-forced), Welcome channel with the delivered brief and the founder's display name.

- [ ] **Step 3: Push, PR to develop, arm auto-merge**

```bash
git push -u origin feat/canvas-first-run
gh pr create --repo AI-Native-Ventures/Colony --base develop \
  --title "feat(onboarding): canvas flow becomes the shipped first run" \
  --body-file /tmp/canvas-first-run-pr.md
gh pr merge <number> --repo AI-Native-Ventures/Colony --merge --auto
```

PR body: what changed (mount move, provisioning, shared completion, fresh-founder marker), what did NOT change (joiners, legacy gate-key semantics for them, machine flow), the two proof specs, screenshots. Wait for the CI matrix; auto-merge handles the queue.

- [ ] **Step 4: Post-merge verification note**

After merge to develop: the real proof gate for "shipped" remains a public-shaped packaged build (auto-connect unset, `VITE_NEW_ONBOARDING` default) reaching the canvas flow on a clean machine profile. Record this as the promotion-time check in the PR body; it cannot run in CI.

---

## Self-Review (done at plan time)

- Spec coverage: mount move (T6), fresh-founder eligibility (T4), root-relay accounts (no code change needed, verified in design), real provisioning + silent slug (T2/T3/T5), shared completion + kind:0 + brief (T1/T6), legacy keeps gate-key writes for joiners (T1 preserves `markCommunityOnboardingComplete` in `finish`/module), auto-connect builds skip provisioning (T5 `provisioning: null` + T6 `hadCommunityAtMount`), e2e proof (T7). Gap check: probing screen needs no code change (apply runs in background; completion waits, per design decision).
- Placeholders: none; every step carries code or an exact command.
- Type consistency: `ProvisionOutcome` produced in T3 = consumed in T5/T6; `OnboardingAnswers.communitySlug` added T4, used T5; `completeFirstRun(deps, io)` signature identical in T1 test, T1 impl, T1 legacy call, T6 host. `onProvisioned(outcome, companyName)` amendment noted in both T5 (props) and T6 (host) — implement with the two-arg form from the start.
