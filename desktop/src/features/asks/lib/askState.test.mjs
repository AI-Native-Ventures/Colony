import assert from "node:assert/strict";
import test from "node:test";

import {
  askDeadlineBadgeLabel,
  askDeadlineBadgeVariant,
  askDeadlineUrgency,
  askSecondsRemaining,
  askStatesFromEvents,
  describeAskExpiry,
  formatAskDeadline,
  readAskState,
} from "./askState.ts";

const ASK_ID = "a".repeat(64);
const SUCCESSOR_ID = "b".repeat(64);
const RELAY_HEX = "c".repeat(64);
const IMPOSTOR_HEX = "d".repeat(64);

const NOW_SECS = 1_700_000_000;
const NOW_MS = 1_700_000_000_000;

function head(content, overrides = {}) {
  return {
    id: "state-1",
    kind: 30200,
    pubkey: RELAY_HEX,
    created_at: NOW_SECS,
    content: JSON.stringify(content),
    tags: [["d", ASK_ID]],
    sig: "",
    ...overrides,
  };
}

// --- authorship -------------------------------------------------------------

test("a head signed by anyone but the relay is refused", () => {
  const forged = head(
    {
      status: "open",
      deadline_at: NOW_SECS + 60,
      on_expiry: "default_executes",
      default_option: "proceed",
    },
    { pubkey: IMPOSTOR_HEX },
  );
  assert.equal(readAskState(forged, RELAY_HEX), null);
});

test("a head is refused while the relay's own pubkey is unknown", () => {
  const event = head({
    status: "open",
    deadline_at: NOW_SECS + 60,
    on_expiry: "rearms",
  });
  assert.equal(readAskState(event, null), null);
  assert.equal(readAskState(event, undefined), null);
});

test("authorship is compared case-insensitively", () => {
  const event = head(
    { status: "open", deadline_at: NOW_SECS + 60, on_expiry: "rearms" },
    { pubkey: RELAY_HEX.toUpperCase() },
  );
  assert.ok(readAskState(event, RELAY_HEX));
});

// --- parsing ----------------------------------------------------------------

test("an open head carries the relay's deadline and expiry action", () => {
  const state = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS + 3_600,
      on_expiry: "rearms",
    }),
    RELAY_HEX,
  );
  assert.ok(state);
  assert.equal(state.askId, ASK_ID);
  assert.equal(state.status, "open");
  assert.equal(state.deadlineAt, NOW_SECS + 3_600);
  assert.equal(state.onExpiry, "rearms");
  assert.equal(state.rearmedAt, null);
});

test("reads an open default-execution head", () => {
  const state = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS,
      on_expiry: "default_executes",
      default_option: "B",
    }),
    RELAY_HEX,
  );
  assert.equal(state?.askId, ASK_ID);
  assert.equal(state?.status, "open");
  assert.equal(state?.deadlineAt, NOW_SECS);
  assert.equal(state?.onExpiry, "default_executes");
  assert.equal(state?.defaultOption, "B");
  assert.equal(state?.promotesTo, null);
  assert.equal(state?.rearmedAt, null);
});

test("reads an open promotion head and a re-armed marker", () => {
  const state = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS,
      on_expiry: "promotes",
      promotes_to: "owner",
      rearmed_at: NOW_SECS - 1_000,
    }),
    RELAY_HEX,
  );
  assert.equal(state?.onExpiry, "promotes");
  assert.equal(state?.promotesTo, "owner");
  assert.equal(state?.rearmedAt, NOW_SECS - 1_000);
});

test("reads a promoted terminal head with its successor", () => {
  const state = readAskState(
    head({
      status: "promoted",
      closed_at: NOW_SECS + 100,
      successor_event_id: SUCCESSOR_ID,
    }),
    RELAY_HEX,
  );
  assert.equal(state?.status, "promoted");
  assert.equal(state?.successorAskId, SUCCESSOR_ID);
  assert.equal(state?.closedAt, NOW_SECS + 100);
  assert.equal(state?.deadlineAt, null);
});

test("unknown content fields are ignored so newer relays still parse", () => {
  const state = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS + 60,
      on_expiry: "rearms",
      some_future_field: { nested: true },
    }),
    RELAY_HEX,
  );
  assert.ok(state);
  assert.equal(state.onExpiry, "rearms");
});

// --- cross-field rules, mirroring parse_ask_state ---------------------------

test("rejects an open head with no deadline", () => {
  assert.equal(
    readAskState(head({ status: "open", on_expiry: "rearms" }), RELAY_HEX),
    null,
  );
});

test("rejects an open head that names no expiry action", () => {
  assert.equal(
    readAskState(
      head({ status: "open", deadline_at: NOW_SECS + 60 }),
      RELAY_HEX,
    ),
    null,
  );
});

test("rejects an open default-execution head that names no option", () => {
  assert.equal(
    readAskState(
      head({
        status: "open",
        deadline_at: NOW_SECS + 60,
        on_expiry: "default_executes",
      }),
      RELAY_HEX,
    ),
    null,
  );
});

test("rejects an open promotion head that names no rung", () => {
  assert.equal(
    readAskState(
      head({
        status: "open",
        deadline_at: NOW_SECS + 60,
        on_expiry: "promotes",
      }),
      RELAY_HEX,
    ),
    null,
  );
});

// --- malformed input --------------------------------------------------------

test("an unknown status is refused rather than partially trusted", () => {
  assert.equal(readAskState(head({ status: "sideways" }), RELAY_HEX), null);
  assert.equal(readAskState(head({ status: "half-open" }), RELAY_HEX), null);
});

test("rejects unknown vocabulary and malformed content", () => {
  assert.equal(
    readAskState(
      head({
        status: "open",
        deadline_at: NOW_SECS + 60,
        on_expiry: "explodes",
      }),
      RELAY_HEX,
    ),
    null,
  );
  assert.equal(
    readAskState(
      head({
        status: "open",
        deadline_at: NOW_SECS + 60,
        on_expiry: "promotes",
        promotes_to: "board",
      }),
      RELAY_HEX,
    ),
    null,
  );
  assert.equal(readAskState(head({}, { content: "{" }), RELAY_HEX), null);
  assert.equal(
    readAskState(head({ status: "open" }, { kind: 44300 }), RELAY_HEX),
    null,
  );
});

test("an invalid integer field drops the head rather than reading as absent", () => {
  // `ask_state_int_field` errors on these; treating them as "no deadline"
  // would render a live ask as though it had no clock at all.
  for (const deadline of ["soon", -1, 1.5, true]) {
    assert.equal(
      readAskState(
        head({ status: "resolved", closed_at: deadline }),
        RELAY_HEX,
      ),
      null,
    );
  }
});

test("a successor id that is not hex64 drops the head", () => {
  assert.equal(
    readAskState(
      head({ status: "promoted", successor_event_id: "nope" }),
      RELAY_HEX,
    ),
    null,
  );
});

test("fails closed on a duplicate d tag, exactly as the relay parser does", () => {
  assert.equal(
    readAskState(
      head(
        { status: "open", deadline_at: NOW_SECS + 60, on_expiry: "rearms" },
        {
          tags: [
            ["d", ASK_ID],
            ["d", SUCCESSOR_ID],
          ],
        },
      ),
      RELAY_HEX,
    ),
    null,
  );
});

// --- latest-wins ------------------------------------------------------------

test("latest-wins per ask id when several revisions arrive together", () => {
  const states = askStatesFromEvents(
    [
      head(
        { status: "open", deadline_at: 10, on_expiry: "rearms" },
        { created_at: 5 },
      ),
      head({ status: "resolved", closed_at: 20 }, { created_at: 9 }),
      head(
        { status: "open", deadline_at: 30, on_expiry: "rearms" },
        { created_at: 7 },
      ),
    ],
    RELAY_HEX,
  );
  assert.equal(states.size, 1);
  assert.equal(states.get(ASK_ID)?.status, "resolved");
});

test("a forged head cannot displace the relay's own in the map", () => {
  const states = askStatesFromEvents(
    [
      head(
        { status: "open", deadline_at: NOW_SECS + 60, on_expiry: "rearms" },
        { created_at: NOW_SECS },
      ),
      head(
        { status: "resolved", closed_at: NOW_SECS },
        { created_at: NOW_SECS + 100, pubkey: IMPOSTOR_HEX },
      ),
    ],
    RELAY_HEX,
  );
  assert.equal(states.size, 1);
  assert.equal(states.get(ASK_ID)?.status, "open");
});

// --- urgency thresholds -----------------------------------------------------

test("urgency: an already-expired deadline", () => {
  assert.equal(askDeadlineUrgency(NOW_SECS - 1, NOW_MS), "expired");
  assert.equal(askDeadlineUrgency(NOW_SECS, NOW_MS), "expired");
  assert.equal(askDeadlineBadgeVariant("expired"), "destructive");
  assert.equal(
    askDeadlineBadgeLabel(NOW_SECS - 600, NOW_MS),
    "Deadline passed",
  );
});

test("urgency: under one hour is critical, one hour exactly is not", () => {
  assert.equal(askDeadlineUrgency(NOW_SECS + 3_599, NOW_MS), "critical");
  assert.equal(askDeadlineUrgency(NOW_SECS + 3_600, NOW_MS), "soon");
  assert.equal(askDeadlineBadgeVariant("critical"), "warning");
});

test("urgency: under a day is soon, a day or more is later", () => {
  assert.equal(askDeadlineUrgency(NOW_SECS + 86_399, NOW_MS), "soon");
  assert.equal(askDeadlineUrgency(NOW_SECS + 86_400, NOW_MS), "later");
  assert.equal(askDeadlineBadgeVariant("soon"), "outline");
  assert.equal(askDeadlineBadgeVariant("later"), "secondary");
});

test("seconds remaining goes negative once the deadline passes", () => {
  assert.equal(askSecondsRemaining(NOW_SECS + 40, NOW_MS), 40);
  assert.equal(askSecondsRemaining(NOW_SECS - 40, NOW_MS), -40);
});

// --- formatting -------------------------------------------------------------

test("formats relative and absolute together, never one alone", () => {
  const text = formatAskDeadline(NOW_SECS + 40 * 60, NOW_MS);
  assert.match(text, /^in 40 minutes, at .+$/);
});

test("formats sub-minute, hour, and multi-day spans", () => {
  assert.match(
    formatAskDeadline(NOW_SECS + 30, NOW_MS),
    /^in less than a minute, /,
  );
  assert.match(formatAskDeadline(NOW_SECS + 7_200, NOW_MS), /^in 2 hours, /);
  assert.match(
    formatAskDeadline(NOW_SECS + 3_600 + 60, NOW_MS),
    /^in 1 hour 1 minute, /,
  );
  assert.match(
    formatAskDeadline(NOW_SECS + 3 * 86_400, NOW_MS),
    /^in 3 days, on /,
  );
});

test("a passed deadline reads backwards", () => {
  assert.match(
    formatAskDeadline(NOW_SECS - 5 * 60, NOW_MS),
    /^5 minutes ago, /,
  );
});

test("badge label counts down in whole minutes", () => {
  assert.equal(
    askDeadlineBadgeLabel(NOW_SECS + 40 * 60, NOW_MS),
    "Due in 40 minutes",
  );
  assert.equal(askDeadlineBadgeLabel(NOW_SECS + 60, NOW_MS), "Due in 1 minute");
});

// --- expiry copy ------------------------------------------------------------

test("expiry copy names the default option in plain words", () => {
  const state = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS + 600,
      on_expiry: "default_executes",
      default_option: "Send 15 emails",
    }),
    RELAY_HEX,
  );
  assert.equal(
    describeAskExpiry(state, NOW_SECS - 60, NOW_SECS),
    'If you do not answer in time, Colony picks "Send 15 emails" for you.',
  );
});

test("the sentence names the outcome and leaves the countdown to the badge", () => {
  const deadlineAt = NOW_SECS + 2 * 3_600;
  const state = readAskState(
    head({
      status: "open",
      deadline_at: deadlineAt,
      on_expiry: "default_executes",
      default_option: "proceed",
    }),
    RELAY_HEX,
  );
  const sentence = describeAskExpiry(state, NOW_SECS - 60, NOW_SECS);
  assert.match(sentence, /"proceed"/);
  // One statement of the time remaining, not three. `AskDeadlineNote` renders
  // the badge and the relative-plus-absolute line above this sentence, so a
  // third copy here would only give the three of them a chance to disagree.
  assert.doesNotMatch(sentence, /2 hours/);
  assert.equal(askDeadlineBadgeLabel(deadlineAt, NOW_MS), "Due in 2 hours");
});

test("a passed default-execution deadline points at the next sweep", () => {
  const state = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS - 60,
      on_expiry: "default_executes",
      default_option: "proceed",
    }),
    RELAY_HEX,
  );
  assert.equal(
    describeAskExpiry(state, NOW_SECS - 600, NOW_SECS),
    'The deadline has passed; Colony applies "proceed" on the next sweep.',
  );
});

test("expiry copy distinguishes promotion targets", () => {
  const toOwner = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS + 600,
      on_expiry: "promotes",
      promotes_to: "owner",
    }),
    RELAY_HEX,
  );
  const toExecutive = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS + 600,
      on_expiry: "promotes",
      promotes_to: "executive",
    }),
    RELAY_HEX,
  );
  assert.match(
    describeAskExpiry(toOwner, NOW_SECS - 60, NOW_SECS),
    /community owner/,
  );
  assert.match(
    describeAskExpiry(toExecutive, NOW_SECS - 60, NOW_SECS),
    /the executive/,
  );
});

test("a re-arming ask says plainly that nothing happens without an answer", () => {
  const state = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS + 3_600,
      on_expiry: "rearms",
    }),
    RELAY_HEX,
  );
  const sentence = describeAskExpiry(state, NOW_SECS - 11 * 86_400, NOW_SECS);
  assert.match(sentence, /Nothing happens automatically/);
  assert.match(sentence, /will not resolve on its own/);
  assert.match(sentence, /Waiting 11 days so far/);
});

test("a one-day wait is singular, and a fresh ask states no wait at all", () => {
  const state = readAskState(
    head({
      status: "open",
      deadline_at: NOW_SECS + 60,
      on_expiry: "rearms",
    }),
    RELAY_HEX,
  );
  assert.match(
    describeAskExpiry(state, NOW_SECS - 86_400, NOW_SECS),
    /Waiting 1 day so far/,
  );
  assert.doesNotMatch(
    describeAskExpiry(state, NOW_SECS - 60, NOW_SECS),
    /Waiting/,
  );
});

test("a closed head has no expiry copy and no deadline to render", () => {
  const state = readAskState(
    head({ status: "resolved", closed_at: NOW_SECS, default_executed: true }),
    RELAY_HEX,
  );
  assert.ok(state);
  assert.equal(state.defaultExecuted, true);
  assert.equal(state.deadlineAt, null);
  assert.equal(describeAskExpiry(state, NOW_SECS - 60, NOW_SECS), null);
});
