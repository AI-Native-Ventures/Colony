import type { OpenAsk } from "@/features/asks/lib/askEvent";
import {
  ASK_DEADLINE_CRITICAL_SECS,
  askDeadlineBadgeLabel,
  askSecondsRemaining,
  type AskState,
} from "@/features/asks/lib/askState";

/**
 * Deciding which open asks are worth interrupting somebody for, and which
 * ones this app has already interrupted them about.
 *
 * Pure on purpose: the React hook around it (`useAskNotifications`) owns
 * timers, storage and the desktop notification call, and none of that is
 * testable. Everything that decides WHETHER to notify lives here.
 */

/** Why an ask is being announced. */
export type AskNotificationKind = "arrived" | "promoted" | "deadline";

/** One notification the app should deliver, if it has not already. */
export type AskNotificationSignal = {
  /**
   * The dedupe key. Scoped by both ask id and kind, so an ask can announce
   * its arrival and, later, its approaching deadline, but never announce
   * either of those twice.
   */
  key: string;
  kind: AskNotificationKind;
  askId: string;
  title: string;
  body: string;
};

/**
 * How much time left counts as "approaching". One hour, the same threshold
 * the card's amber badge uses, and for the same reason: 3600 seconds is the
 * window the broker falls back to when nothing states one (NIP-IQ,
 * `default_window_secs`), so under an hour is under one whole default window.
 */
export const ASK_DEADLINE_WARNING_SECS = ASK_DEADLINE_CRITICAL_SECS;

/** Cap on the persisted dedupe set, mirroring the home-feed seen set. */
export const ASK_NOTIFICATION_SEEN_MAX = 500;

function arrivalKey(ask: OpenAsk): string {
  // A relay-promoted ask carries a `prior` tag. It is announced as a
  // promotion rather than an arrival, because "this moved up to you because
  // nobody below answered" is a different fact from "somebody filed this".
  return ask.priorAskId ? `promoted:${ask.id}` : `arrived:${ask.id}`;
}

function deadlineKey(askId: string): string {
  return `deadline:${askId}`;
}

/**
 * What a fresh ask says on the notification, per NIP-IQ's `ask-type`
 * vocabulary. "A decision is waiting" is wrong for a credential handoff and
 * useless for a stall, and the type is the one word that tells the owner
 * whether this needs thought, a secret, or a hand.
 */
const ARRIVAL_TITLE_BY_TYPE: Record<string, string> = {
  decision: "An agent needs a decision",
  question: "An agent has a question",
  credential: "An agent needs a credential",
  blocker: "An agent is blocked on you",
  stall: "A task has gone silent",
};

function arrivalTitle(ask: OpenAsk): string {
  return ARRIVAL_TITLE_BY_TYPE[ask.askType] ?? "An agent needs you";
}

/**
 * The arrival keys for every ask currently open, used to seed the dedupe set
 * on the first pass after launch or a community switch.
 *
 * Without this seed, opening the app would replay every ask already sitting
 * in the inbox as a fresh notification. Same reasoning as the reminder
 * watermark seeding to `now` rather than 0. Deadline keys are deliberately
 * NOT seeded: an ask that is genuinely about to expire while the app starts
 * is exactly the case this feature exists for.
 */
export function askArrivalDedupeKeys(asks: readonly OpenAsk[]): string[] {
  return asks.map(arrivalKey);
}

/**
 * Which notifications are due right now.
 *
 * `asks` must already be the OPEN set: `useOpenAsks` subtracts every ask
 * named by a resolution (44301) or withdrawal (44302), so an answered or
 * withdrawn ask is absent here and can never produce a signal. The deadline
 * signal additionally requires the relay's own head to still read `open`, so
 * a closure the ask query has not caught up with yet cannot slip one through.
 *
 * At most one signal per ask per pass: an ask that arrives already inside the
 * warning window announces its arrival, and its deadline warning waits for
 * the next pass rather than firing two notifications about one thing at once.
 */
export function askNotificationSignals(input: {
  asks: readonly OpenAsk[];
  states: ReadonlyMap<string, AskState>;
  nowMs: number;
  delivered: ReadonlySet<string>;
}): AskNotificationSignal[] {
  const signals: AskNotificationSignal[] = [];

  for (const ask of input.asks) {
    const arrival = arrivalKey(ask);
    if (!input.delivered.has(arrival)) {
      signals.push({
        key: arrival,
        kind: ask.priorAskId ? "promoted" : "arrived",
        askId: ask.id,
        title: ask.priorAskId ? "Ask promoted to you" : arrivalTitle(ask),
        body: ask.headline,
      });
      continue;
    }

    const state = input.states.get(ask.id);
    if (state?.status !== "open" || state.deadlineAt === null) continue;
    const remaining = askSecondsRemaining(state.deadlineAt, input.nowMs);
    // Already past is not "approaching": the sweep has either acted or
    // re-armed, and either way there is nothing to warn about.
    if (remaining <= 0 || remaining > ASK_DEADLINE_WARNING_SECS) continue;

    // Once per ask, never once per re-arm. A re-armed timer is by definition
    // the harmless branch: the sweep only re-arms an ask it can neither
    // default-execute nor promote, so nothing fires at zero and a second
    // warning would be noise about a deadline with no consequence.
    const key = deadlineKey(ask.id);
    if (input.delivered.has(key)) continue;
    signals.push({
      key,
      kind: "deadline",
      askId: ask.id,
      title: `Ask ${askDeadlineBadgeLabel(state.deadlineAt, input.nowMs).toLowerCase()}`,
      body: ask.headline,
    });
  }

  return signals;
}

/**
 * Add keys to the persisted dedupe set, oldest-first eviction past the cap.
 * Returns the same array when nothing changed, so callers can skip the write.
 */
export function mergeAskNotificationKeys(
  current: readonly string[],
  next: readonly string[],
  max: number = ASK_NOTIFICATION_SEEN_MAX,
): string[] {
  const merged = new Set(current);
  let changed = false;
  for (const key of next) {
    if (merged.has(key)) continue;
    merged.add(key);
    changed = true;
  }
  if (!changed) return current as string[];
  const values = [...merged];
  return values.length <= max ? values : values.slice(values.length - max);
}
