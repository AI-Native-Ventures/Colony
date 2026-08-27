import type { RelayEvent } from "@/shared/api/types";
import { KIND_ASK_STATE } from "@/shared/constants/kinds";

/**
 * Reading relay-signed ask-state heads (kind 30200).
 *
 * One parameterized-replaceable head per Ask (`d` = the ask event id),
 * signed by the relay, carrying the `asks` projection's own `deadline_at`
 * plus a named expiry outcome, republished on filing, on re-arm, and on every
 * closure (`buzz-relay/src/ask_state_head.rs`). The relay is the only thing
 * that can compute that deadline (the window comes from the ask's content or
 * the company profile, then gets clamped), so this is a read path, never a
 * recompute: a countdown that disagrees with the sweep is worse than none.
 *
 * `onExpiry` is the field that matters most on a spend ask. NIP-IQ's hard
 * list forbids a `default_option` on `spend`, `hiring`, `legal` and the rest,
 * so those asks expire to `"rearms"`: the relay pushes the deadline out and
 * waits again, forever, until a human answers. That is deliberate, and it is
 * the reason this head has to be visible: an owner who never opens the ask
 * has a campaign parked indefinitely with nothing on screen saying so.
 *
 * Parsing mirrors `buzz_core::interrupt::parse_ask_state`: unknown content
 * fields are ignored so a newer relay can add them, integer fields are read
 * strictly and non-negative, pinned vocabularies reject values they do not
 * name, and the cross-field rules an OPEN head must satisfy are enforced here
 * too. Anything malformed yields null rather than a partially-trusted record,
 * because a half-interpreted head is exactly the shape a countdown cannot be
 * built on honestly.
 */

/** Lifecycle status of the Ask a head describes. */
export type AskStateStatus = "open" | "resolved" | "withdrawn" | "promoted";

/** What the relay does when an open Ask's deadline passes. */
export type AskExpiryAction = "default_executes" | "promotes" | "rearms";

/** The altitude rung an expiring Ask climbs to. */
export type AskPromotionTarget = "executive" | "owner";

export type AskState = {
  /** The ask this head describes (its `d` tag). */
  askId: string;
  status: AskStateStatus;
  /** Relay-stored deadline, seconds since epoch. Null once closed. */
  deadlineAt: number | null;
  /** What happens at the deadline. Null once closed. */
  onExpiry: AskExpiryAction | null;
  /** The option that fires on expiry, on `default_executes` heads. */
  defaultOption: string | null;
  /** The rung the ask climbs to, on `promotes` heads. */
  promotesTo: AskPromotionTarget | null;
  /** When the sweep last pushed the deadline out. Null if never re-armed. */
  rearmedAt: number | null;
  /** When the ask closed, seconds since epoch. Closed heads only. */
  closedAt: number | null;
  /** Whether the closing resolution executed the stated default. */
  defaultExecuted: boolean;
  /** Where the live countdown continues, on a `promoted` head. */
  successorAskId: string | null;
};

/** A lowercase hex string of exactly 64 characters (an event id). */
const HEX64 = /^[0-9a-f]{64}$/;

const ASK_STATE_STATUSES: ReadonlySet<string> = new Set([
  "open",
  "resolved",
  "withdrawn",
  "promoted",
]);

const ASK_EXPIRY_ACTIONS: ReadonlySet<string> = new Set([
  "default_executes",
  "promotes",
  "rearms",
]);

const ASK_PROMOTION_TARGETS: ReadonlySet<string> = new Set([
  "executive",
  "owner",
]);

function singleTagValue(event: RelayEvent, name: string): string | null {
  const values = (event.tags ?? [])
    .filter((tag) => tag[0] === name)
    .map((tag) => tag[1]);
  // Duplicates fail closed, the same rule the resolution parser follows: a
  // head naming two different asks describes neither of them.
  return values.length === 1 ? (values[0] ?? null) : null;
}

/**
 * A non-negative integer content field. `null` means absent, `undefined`
 * means present but invalid, which is a reason to drop the whole head:
 * `ask_state_int_field` errors on such a value rather than treating it as
 * absent, and a client that quietly read it as "no deadline" would render a
 * live ask as though it had no clock at all.
 */
function nonNegativeInt(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

/** A pinned-vocabulary string field, with the same three-way result. */
function pinnedString<T extends string>(
  value: unknown,
  vocabulary: ReadonlySet<string>,
): T | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return undefined;
  return vocabulary.has(value) ? (value as T) : undefined;
}

/**
 * Parse one kind-30200 event into an {@link AskState}, or null when it is not
 * a well-formed head signed by `relaySelfPubkey`. Never throws: one malformed
 * head must not blank the ask it describes.
 *
 * Authorship is checked here rather than by the caller because this kind is
 * relay-only: a head from any other pubkey is a forgery claiming a deadline
 * the relay never set, and showing its countdown would be worse than showing
 * nothing.
 */
export function readAskState(
  event: RelayEvent,
  relaySelfPubkey: string | null | undefined,
): AskState | null {
  if (event.kind !== KIND_ASK_STATE) return null;
  if (
    typeof relaySelfPubkey !== "string" ||
    event.pubkey.toLowerCase() !== relaySelfPubkey.toLowerCase()
  ) {
    return null;
  }

  const askId = singleTagValue(event, "d");
  if (askId === null || !HEX64.test(askId)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const fields = parsed as Record<string, unknown>;

  const status = pinnedString<AskStateStatus>(
    fields.status,
    ASK_STATE_STATUSES,
  );
  if (status === undefined || status === null) return null;

  const deadlineAt = nonNegativeInt(fields.deadline_at);
  const rearmedAt = nonNegativeInt(fields.rearmed_at);
  const closedAt = nonNegativeInt(fields.closed_at);
  if (
    deadlineAt === undefined ||
    rearmedAt === undefined ||
    closedAt === undefined
  ) {
    return null;
  }

  const onExpiry = pinnedString<AskExpiryAction>(
    fields.on_expiry,
    ASK_EXPIRY_ACTIONS,
  );
  if (onExpiry === undefined) return null;

  const promotesTo = pinnedString<AskPromotionTarget>(
    fields.promotes_to,
    ASK_PROMOTION_TARGETS,
  );
  if (promotesTo === undefined) return null;

  const defaultOption =
    typeof fields.default_option === "string" &&
    fields.default_option.trim() !== ""
      ? fields.default_option
      : null;

  const successorRaw = fields.successor_event_id;
  let successorAskId: string | null = null;
  if (typeof successorRaw === "string" && successorRaw !== "") {
    if (!HEX64.test(successorRaw)) return null;
    successorAskId = successorRaw;
  }

  // Cross-field rules for OPEN heads, mirroring `parse_ask_state`. A head
  // missing any of these is exactly the shape a countdown cannot be built on.
  if (status === "open") {
    if (deadlineAt === null || onExpiry === null) return null;
    if (onExpiry === "default_executes" && defaultOption === null) return null;
    if (onExpiry === "promotes" && promotesTo === null) return null;
  }

  return {
    askId,
    status,
    deadlineAt,
    onExpiry,
    defaultOption,
    promotesTo,
    rearmedAt,
    closedAt,
    defaultExecuted: fields.default_executed === true,
    successorAskId,
  };
}

/**
 * Latest head per ask id, keyed by ask id.
 *
 * The relay writes NIP-33 parameterized-replaceable heads, so the relay
 * itself already resolves latest-wins, but a client that queried before a
 * replacement propagated (or replayed a batch across a reconnect) can still
 * hold both, so this keeps the newer `created_at` rather than whichever
 * arrived last in the array.
 */
export function askStatesFromEvents(
  events: readonly RelayEvent[],
  relaySelfPubkey: string | null | undefined,
): Map<string, AskState> {
  const byAskId = new Map<string, { state: AskState; createdAt: number }>();
  for (const event of events) {
    const state = readAskState(event, relaySelfPubkey);
    if (state === null) continue;
    const existing = byAskId.get(state.askId);
    if (existing !== undefined && existing.createdAt >= event.created_at) {
      continue;
    }
    byAskId.set(state.askId, { state, createdAt: event.created_at });
  }
  return new Map(
    [...byAskId].map(([askId, entry]) => [askId, entry.state] as const),
  );
}

/**
 * How close an open ask is to its deadline.
 *
 * The thresholds are the protocol's own units, not taste:
 *
 * - `critical` is under one hour, because 3600 seconds is the window the
 *   broker falls back to when neither the ask nor the community's company
 *   profile states one (NIP-IQ, `default_window_secs`). Under an hour left
 *   means less than one whole default window remains.
 * - `soon` is under a day, the span past which a person should not have to do
 *   date arithmetic in their head.
 * - `later` is everything above that, and is styled as quietly as the rest of
 *   the card. An ask due in nine days must not shout.
 */
export type AskDeadlineUrgency = "expired" | "critical" | "soon" | "later";

export const ASK_DEADLINE_CRITICAL_SECS = 3_600;
export const ASK_DEADLINE_SOON_SECS = 86_400;

/** Seconds left before `deadlineAt`, negative once it has passed. */
export function askSecondsRemaining(deadlineAt: number, nowMs: number): number {
  return deadlineAt - Math.floor(nowMs / 1_000);
}

export function askDeadlineUrgency(
  deadlineAt: number,
  nowMs: number,
): AskDeadlineUrgency {
  const remaining = askSecondsRemaining(deadlineAt, nowMs);
  if (remaining <= 0) return "expired";
  if (remaining < ASK_DEADLINE_CRITICAL_SECS) return "critical";
  if (remaining < ASK_DEADLINE_SOON_SECS) return "soon";
  return "later";
}

/**
 * Badge variant per urgency, using the existing `shared/ui/badge` vocabulary.
 * `later` deliberately gets the same muted treatment as every other meta chip
 * on the card.
 */
export function askDeadlineBadgeVariant(
  urgency: AskDeadlineUrgency,
): "destructive" | "warning" | "outline" | "secondary" {
  switch (urgency) {
    case "expired":
      return "destructive";
    case "critical":
      return "warning";
    case "soon":
      return "outline";
    default:
      return "secondary";
  }
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * A whole-minute-or-coarser description of a span. Minute granularity is
 * deliberate: the relay's due-ask sweep runs on `BUZZ_INTERRUPT_SWEEP_SECS`
 * (60 by default), so a seconds countdown would claim precision the relay
 * does not honour, and it would cost a per-second re-render to display.
 */
function formatSpan(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  if (seconds < 60) return "less than a minute";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return pluralize(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes === 0
      ? pluralize(hours, "hour")
      : `${pluralize(hours, "hour")} ${pluralize(restMinutes, "minute")}`;
  }
  return pluralize(Math.floor(hours / 24), "day");
}

/** The wall-clock time a deadline falls at, in the reader's own locale. */
function formatClock(deadlineAt: number, nowMs: number): string {
  const when = new Date(deadlineAt * 1_000);
  const time = when.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (new Date(nowMs).toDateString() === when.toDateString()) {
    return `at ${time}`;
  }
  const date = when.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
  return `on ${date} at ${time}`;
}

/**
 * Relative and absolute together, so nobody has to do arithmetic:
 * "in 40 minutes, at 4:15 PM". A passed deadline reads backwards.
 */
export function formatAskDeadline(deadlineAt: number, nowMs: number): string {
  const remaining = askSecondsRemaining(deadlineAt, nowMs);
  const clock = formatClock(deadlineAt, nowMs);
  return remaining <= 0
    ? `${formatSpan(-remaining)} ago, ${clock}`
    : `in ${formatSpan(remaining)}, ${clock}`;
}

/** Short chip text for the urgency badge. */
export function askDeadlineBadgeLabel(
  deadlineAt: number,
  nowMs: number,
): string {
  const remaining = askSecondsRemaining(deadlineAt, nowMs);
  return remaining <= 0 ? "Deadline passed" : `Due in ${formatSpan(remaining)}`;
}

/** Whole days between two timestamps, floored at zero. */
function daysBetween(fromSeconds: number, toSeconds: number): number {
  return Math.max(0, Math.floor((toSeconds - fromSeconds) / 86_400));
}

/**
 * What happens at zero, in words somebody who has never read this protocol
 * can act on, or null when there is nothing worth saying (a closed ask, or a
 * head with no deadline). The three cases are the relay's three real
 * outcomes, read off the head's own `on_expiry` rather than guessed from tags.
 *
 * It deliberately carries no countdown of its own. `AskDeadlineNote` renders
 * the time remaining directly above this sentence, twice over: the urgency
 * badge and the relative-plus-absolute line. A third copy of the same number
 * inside the sentence would be noise, and it would drift out of step with the
 * other two the moment a tick landed between renders.
 *
 * The `"rearms"` wording is the important one and is deliberately blunt: the
 * relay is not going to decide this, and the alternative to saying so is an
 * owner assuming a timeout eventually settles it. `askCreatedAt` turns "still
 * waiting" into a number, because "waiting" and "waiting since eleven days
 * ago" call for different reactions.
 */
export function describeAskExpiry(
  state: AskState,
  askCreatedAt: number,
  nowSeconds: number,
): string | null {
  if (state.status !== "open" || state.deadlineAt === null) return null;
  const passed = state.deadlineAt <= nowSeconds;

  switch (state.onExpiry) {
    case "default_executes": {
      // An open head only reaches here with a stated option: the cross-field
      // rules reject a `default_executes` head that names none.
      const option = state.defaultOption ?? "";
      return passed
        ? `The deadline has passed; Colony applies "${option}" on the next sweep.`
        : `If you do not answer in time, Colony picks "${option}" for you.`;
    }
    case "promotes":
      if (passed) {
        return "The deadline has passed; Colony hands this up a rung on the next sweep.";
      }
      return state.promotesTo === "owner"
        ? "If you do not answer in time, Colony hands this to a community owner instead."
        : "If you do not answer in time, Colony hands this up to the executive instead.";
    case "rearms": {
      const waitingDays = daysBetween(askCreatedAt, nowSeconds);
      const waiting =
        waitingDays >= 1
          ? ` Waiting ${waitingDays} day${waitingDays === 1 ? "" : "s"} so far.`
          : "";
      return `Nothing happens automatically. No default was stated and there is nobody above you to hand it to, so Colony restarts the clock and keeps waiting: this will not resolve on its own.${waiting}`;
    }
    default:
      return null;
  }
}
