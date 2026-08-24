# Forum Live Mention Race Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a live forum mention in Inbox through every stale home-feed response until the durable feed contains that event.

**Architecture:** Store unresolved live forum mentions in a community-scoped React Query cache entry. Every home-feed query reconciles its durable response with that pending entry, preserves absent events, and retires events once the durable response contains them.

**Tech Stack:** React 19, TanStack Query 5, TypeScript, Node test runner, Playwright

---

### Task 1: Prove the stale-refresh sequence

**Files:**
- Modify: `desktop/src/features/home/lib/liveMentionFeed.test.mjs`
- Modify: `desktop/src/features/home/lib/liveMentionFeed.ts`

- [x] **Step 1: Write the failing lifecycle test**

Add a test that passes the same pending forum item through two empty durable responses, then a response containing the item, and finally an empty post-catch-up response. Assert that both stale responses contain the item, catch-up has one copy, the pending list becomes empty, and the final response stays empty.

```js
test("preserves a pending mention through repeated stale reads and releases it after catch-up", () => {
  const liveEvent = event("pending", 9);
  const pending = appendPendingLiveMention([], liveEvent, channels);
  const firstStale = reconcilePendingLiveMentions(feed(), pending);
  const secondStale = reconcilePendingLiveMentions(
    feed(),
    firstStale.pending,
  );
  assert.deepEqual(secondStale.response.feed.mentions.map((item) => item.id), [
    "pending",
  ]);
  assert.equal(secondStale.pending.length, 1);

  const caughtUp = reconcilePendingLiveMentions(
    feed(secondStale.response.feed.mentions),
    secondStale.pending,
  );
  assert.equal(caughtUp.response.feed.mentions.length, 1);
  assert.equal(caughtUp.pending.length, 0);

  const afterRelease = reconcilePendingLiveMentions(feed(), caughtUp.pending);
  assert.equal(afterRelease.response.feed.mentions.length, 0);
});
```

- [x] **Step 2: Run the focused unit test and verify failure**

Run:

```bash
pnpm --dir desktop exec node --import ./test-loader.mjs --experimental-strip-types --test src/features/home/lib/liveMentionFeed.test.mjs
```

Expected: FAIL because `reconcilePendingLiveMentions` is not exported yet.

- [x] **Step 3: Add pending-item and reconciliation helpers**

Implement these interfaces in `liveMentionFeed.ts`:

```ts
export const pendingLiveMentionsQueryKey = (communityId: string) =>
  ["home-feed-pending-live-mentions", communityId] as const;

export function appendPendingLiveMention(
  current: FeedItem[],
  event: RelayEvent,
  channels: readonly FeedChannel[],
): FeedItem[] {
  const item = toMentionItem(
    event,
    new Map(channels.map((channel) => [channel.id, channel])),
  );
  if (item === null) return current;
  const itemsById = new Map(current.map((currentItem) => [currentItem.id, currentItem]));
  itemsById.set(item.id, item);
  return sortAndLimitMentionItems([...itemsById.values()]);
}

export function reconcilePendingLiveMentions(
  durable: HomeFeedResponse,
  pending: readonly FeedItem[],
): { response: HomeFeedResponse; pending: FeedItem[] } {
  const durableIds = new Set(durable.feed.mentions.map((item) => item.id));
  const unresolved = pending.filter((item) => !durableIds.has(item.id));
  return {
    response: mergePendingLiveMentionsIntoHomeFeed(durable, unresolved) ?? durable,
    pending: unresolved,
  };
}
```

`appendPendingLiveMention` converts only forum post/comment mentions, deduplicates by event ID, sorts newest first, and caps the list at 50. `reconcilePendingLiveMentions` removes pending IDs already present in the durable mentions, merges only unresolved items, and adjusts `meta.total` without double-counting.

- [x] **Step 4: Run the focused unit test and verify pass**

Run the Step 2 command again. Expected: all `liveMentionFeed` tests pass.

### Task 2: Reconcile every home-feed response

**Files:**
- Modify: `desktop/src/features/home/useLiveMentionFeedRepair.ts`
- Modify: `desktop/src/features/home/hooks.ts`

- [x] **Step 1: Persist live forum mentions in the query cache**

Replace the hook-local `Map` with `queryClient.setQueryData` at `pendingLiveMentionsQueryKey(communityId)`. Immediately merge the pending items into the visible home-feed cache, then request a refetch.

Keep the pending query observed with infinite stale and garbage-collection times while the active community is mounted. Remove the pending query on community switch or unmount so another community cannot inherit it.

```ts
useQuery<FeedItem[]>({
  queryKey: pendingKey,
  enabled: communityId.length > 0,
  queryFn: () => [],
  initialData: [],
  staleTime: Number.POSITIVE_INFINITY,
  gcTime: Number.POSITIVE_INFINITY,
});
React.useEffect(
  () => () => {
    queryClient.removeQueries({ queryKey: pendingKey, exact: true });
  },
  [pendingKey, queryClient],
);
```

```ts
const pendingKey = pendingLiveMentionsQueryKey(communityId);
const currentPending = queryClient.getQueryData<FeedItem[]>(pendingKey) ?? [];
const nextPending = appendPendingLiveMention(currentPending, event, channels);
if (nextPending === currentPending) return;
queryClient.setQueryData(pendingKey, nextPending);
queryClient.setQueryData<HomeFeedResponse>(queryKey, (current) =>
  mergePendingLiveMentionsIntoHomeFeed(current, nextPending),
);
void refetchHomeFeed();
```

- [x] **Step 2: Reconcile inside the home-feed query**

Snapshot pending mentions before `getHomeFeed`, then reconcile that snapshot with the pending cache after the response resolves. Skip all pending-cache writes when TanStack Query canceled the request, because canceled native reads can still finish after their replacement. This prevents overlapping refreshes from retiring or erasing a mention out of order. Return the repaired response so polling, focus refresh, Inbox mount refresh, and live-triggered refresh follow the same rule.

```ts
const pendingKey = pendingLiveMentionsQueryKey(communityId);
return reconcileHomeFeedRead({
  readDurable: () =>
    getHomeFeed({
      limit: 50,
      types: "mentions,needs_action,activity,agent_activity",
    }),
  readPending: () => queryClient.getQueryData<FeedItem[]>(pendingKey) ?? [],
  signal,
  writePending: (pending) => queryClient.setQueryData(pendingKey, pending),
});
queryClient.setQueryData(pendingKey, reconciled.pending);
return reconciled.response;
```

- [x] **Step 3: Run Desktop package tests**

Run:

```bash
pnpm --dir desktop test
pnpm --dir desktop build
pnpm --dir desktop check
```

Expected: all Desktop unit tests, production build, and repository checks pass.

- [x] **Step 4: Run the browser regression**

Run:

```bash
pnpm --dir desktop build:e2e
pnpm --dir desktop exec playwright test tests/e2e/inbox-live-update.spec.ts --project=smoke --grep "live forum mention survives"
```

Expected: the live forum mention remains visible after the stale durable refetch.

### Task 3: Commit and deliver through develop gates

**Files:**
- Modify: the six product/test files above
- Add: `docs/superpowers/plans/2026-08-21-forum-live-mention-race.md`

- [x] **Step 1: Self-review the exact diff**

Confirm no Spend files, shared schema, shared libraries, or CI workflows changed.

- [ ] **Step 2: Commit with human trailers**

Use `Basheer Phiri <phiribash@gmail.com>` from the repository-local Git config for both `Co-authored-by` and `Signed-off-by`.

- [ ] **Step 3: Open a PR to `develop` and wait for every check**

Open the PR with channel `0b41ede9-9fb3-4a4d-9566-60c70a0403d2`. If `origin/develop` moves, rebase and require fresh green checks before merge.

- [ ] **Step 4: Merge and verify develop CI**

Merge only after all checks are green, then verify push-triggered CI on the exact develop merge commit. Production promotion remains separate and requires Basheer's explicit approval.
