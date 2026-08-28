# A live forum mention can fire its desktop notification and still never reach the Inbox until the next 30-second poll

## Status

**Candidate fix 2 was applied and did NOT close it.** `8efee72438` made
`handleIncomingMessage` dispatch `onLiveMention` as well, so both
subscriptions now drive the Inbox repair. The flake recurred on 2026-08-26
(run 32997225536, `Desktop E2E Integration (1/2)`) with the same signature:
attempt 0 times out at 30.1s, retry #1 passes in 5.1s.

So the mention-subscription race was either not the cause, or not the only
one. The original diagnosis below is left intact because it is still the best
account of what the artifacts show, but its central inference is now
disproven as a complete explanation. Do not treat it as settled.

What is still missing is the same thing that was missing the first time: the
name of the assertion that hangs. `trace: "on-first-retry"` records nothing
for an attempt-0 failure that passes on retry, which is every occurrence of
this flake. That has now been changed to `retain-on-failure` **scoped to the
`integration` project only** — applied globally it pushed four `smoke` shards
over budget and had to be reverted. The next occurrence will carry a trace.

The test itself is still deliberately untouched. Editing it to pass without
understanding the hang would make it green for a reason nobody can defend.

This file exists so the cause is on record rather than living in one agent's
context.

## What the recurrence narrows it to: delivery, not repair

The fourth occurrence (run 32997225536) is the first one with `8efee72438` in
the tree, and that changes what its evidence means.

After that commit **both** subscriptions dispatch `onLiveMention`, and
`useLiveMentionFeedRepair` merges the item into the home-feed query cache
*synchronously* with the dispatch, before it requests any refetch. So a single
delivery on either subscription is enough to put the row in the list with no
relay round trip involved.

The attempt-0 screenshot shows the same Inbox as all three earlier
occurrences, down to its contents: the previous test's `#general` mention and
the old `dm dedupe probe` DM, and no forum ping. Only the timestamps differ.

That rules the repair machinery out. Whatever fails, fails **before**
`onLiveMention`, which is a different place to look than every previous round
of this investigation. Two candidates remain:

1. **No live subscription covers the channel for the target at that moment.**
   Both subscription sets are built from `sidebarChannels`, which is member
   channels. Worth checking that the target is actually a member of
   `watercooler` when the mention lands: the test has *alice* join it
   (`joinChannel(senderPage, "watercooler")`) and never has tyler join
   anything.
2. **The event arrives and `appendPendingLiveMention` returns unchanged.**
   `toMentionItem` returns null when no channel matches the `h` tag, or when
   the matched channel's `channelType` is not `"forum"`, and the hook then
   returns early without merging or refetching.

These are cheap to separate, because they differ in whether the desktop
notification fires. Candidate 1 means no live delivery at all, so no
notification either. Candidate 2 means the event was delivered and only the
mention conversion rejected it, so the notification fires normally. The
notification log on a failing attempt therefore discriminates between them
outright, and the retained trace from `9ee886642a` carries it.

Do not add a third theory before reading that trace. This ticket already has
one confident inference that turned out to be incomplete.

## Observed

`desktop/tests/e2e/integration.spec.ts` >> `live forum mentions refetch the
home feed without waiting for polling` fails its first attempt and passes on
retry. Three distinct CI runs in the retained window, all identical:

| Run | Job |
|---|---|
| 32934763220 | Desktop E2E Integration (1/2) |
| 32922605166 | Desktop E2E Integration (1/2) |
| 32705691942 | Desktop E2E Integration (1/2) |

Every one is a 30s test timeout, and every one reports only this:

```
Test timeout of 30000ms exceeded.
Error: browserContext.close: Target page, context or browser has been closed
  373 |     await expect.poll(() => getLoggedNotificationCount(targetPage)).toBe(1);
  374 |   } finally {
> 375 |     await targetContext.close();
```

That stack is the `finally` block, not the assertion that hung. The hung
assertion is never named, because `playwright.config.ts` sets `trace:
"on-first-retry"` and so attempt 0 records no trace. **This is worth fixing on
its own.** `retain-on-failure` would turn this class of failure from a
multi-hour archaeology exercise into a ten-minute one; the whole diagnosis
below had to be reconstructed from two PNGs and the source.

What the failure screenshots do show: the target user's home Inbox list holds
only leftovers from earlier tests in the same shard (the previous test's
`#general` mention and an old `dm dedupe probe` DM) and never the forum ping
the test is about. The passing retry completes the whole test in 4.5s.

## What is proven: the test synchronizes on nothing

Before opening the Inbox, the test's only wait on the event under test is:

```ts
await expect(targetPage.getByTestId("sidebar-home-count")).toHaveText("1");
```

That is satisfiable by leftover state. `isHomeBadgeFeedItemUnread`
(`src/features/notifications/lib/homeBadge.ts`) falls back to a per-context
`seenFeedIdSet` when an item has no read marker, and every test in this file
opens a fresh browser context, so an old unread DM counts as 1 on load. In the
*passing* retry the badge reads "1" 95ms after the send, which is far too fast
for a relay round trip: it is the leftover, not the forum ping.

The assertion that follows it, `toHaveCount(0)` after opening the Inbox, is
satisfied by `markCurrentFeedSeen` and proves nothing either.

So both badge assertions pass in both directions regardless of the forum ping,
and the single real assertion (`home-inbox-list` contains the message) absorbs
the entire live-delivery race by itself, with whatever remains of a 30s budget
shared across two full app boots.

## The product gap underneath it

This is the part that is *consistent with the artifacts and permitted by the
code*, but has not been observed directly. It is written down as a lead, not a
conclusion.

Two independent subscriptions carry the same event, and only one of them
repairs the Inbox:

- **The channel-message subscription** (`useLiveChannelUpdates.ts`, the
  `liveSubsRef` effect) subscribes per member channel to `CHANNEL_EVENT_KINDS`
  and calls `handleIncomingMessage`, which is what fires the desktop
  notification via `options.onChannelMessage`.
- **The mention subscription** (the `mentionSubsRef` effect) subscribes per
  member channel with `buildChannelMentionFilter` and calls
  `handleMentionEvent`, which is the *only* caller of `options.onLiveMention`,
  which is what drives `useLiveMentionFeedRepair` and therefore the Inbox.

`buildChannelMentionFilter` (`src/shared/api/relayChannelFilters.ts:180`) sets
`since: Math.floor(Date.now() / 1_000)`. It is live-only with no backfill.

Consequence: a forum mention broadcast in the window before that channel's
mention subscription opens is never delivered to the repair path, and there is
no replay to recover it. The desktop notification still fires, because that is
the other subscription with its own independent open time. The Inbox then waits
for the 30s home-feed poll.

The inference the test makes, that a logged notification means the mention was
delivered everywhere it needed to go, is therefore not sound. A notification
proves the first subscription delivered and says nothing about the second.

In production this window is narrow: it exists only between page load and the
mention subscriptions opening, and the 30s poll self-heals it. The test drives
exactly that window on purpose, roughly 200ms after the target's channel list
resolves.

## What would confirm it

Instrument, on a failing run, whether `handleMentionEvent` ever ran for the
event under test. Either:

- a temporary counter on the mention path readable from the page, compared
  against the notification log, or
- a relay-side log of the REQ for that channel's mention filter with its
  `since`, timestamped against the broadcast of the mention event.

If the mention subscription's REQ is timestamped after the event's
`created_at` second, the mechanism above is confirmed. If it opened before,
the cause is something else and this file is wrong.

## Two candidate fixes, one applied and disproven

1. **Test-side, needs new product surface.** Give the relay bridge a readiness
   signal for live subscriptions, the way the mock bridge has
   `waitForMockLiveSubscription`, and wait on it before sending. This means a
   small seam in `relayClientSession`, in the same spirit as the existing
   `__BUZZ_E2E_QUERY_CLIENT__` seam in `src/app/App.tsx`.

2. **Product-side, removes the class of race.** Drive `onLiveMention` from
   `handleIncomingMessage` as well. The channel-message subscription already
   receives every forum post in every member channel, and
   `seenMentionEventIdsRef` / `trackSeenEvent` already deduplicate across both
   paths, so the repair would become exactly as reliable as the notification.

Option 2 was applied in `8efee72438` and did not close the flake. It is kept
because it is correct on its own merits: a notification with an empty Inbox
for thirty seconds is wrong however this test behaves. Option 1 is still
unbuilt.

## Prior art in the same area

`docs/superpowers/plans/2026-08-21-forum-live-mention-race.md` and commits
`24aee58728`, `34a27cb6ba`, `b965af8e1b` built the pending-live-mention cache
so a live forum mention survives a stale home-feed read. That machinery is
sound and is not what fails here. It only runs when `onLiveMention` fires at
all, which is precisely the step in question.

---

# Related finding: positional locators feeding one-shot actions

Raised while fixing `video-attachment.spec.ts` >> `right-click menus expose
distinct selectors ...` (commit `597b3f857e`), where
`page.getByTestId("video-player").last()` resolved to the previous video and
the right-click opened the wrong context menu.

A sweep of all 444 `.last()` / `.first()` uses across `desktop/tests/e2e`
found that one real instance. The rule that separates the dangerous uses from
the harmless ones is worth keeping:

> A positional locator is only dangerous when it feeds a **one-shot action**
> (`.click()`, `.boundingBox()`, `.evaluate()`). An assertion re-resolves its
> locator on every poll, so a wrong initial match heals itself within the
> timeout. An action commits to whatever it matched at that instant and
> produces a stable wrong verdict.

Everything else in the suite is one of: pre-scoped before the positional call
(`messaging.spec.ts:2002` filters by `hasText` first), feeding an assertion
that re-resolves (`agents.spec.ts:1242`), or the only element of its kind on
the page.

Two sites are one-shot actions that are safe today only because their channel
contains a single attachment. They become flakes the day either spec grows a
second one:

- `tests/e2e/workspace-attachment.spec.ts:109` and `:125`
  (`getByTestId("file-card-open" | "file-card-download").last().click()`)

Deliberately not changed speculatively. Noted here so the next person to add
an attachment to those specs knows what they are stepping into.
