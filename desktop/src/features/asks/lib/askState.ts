import type { RelayEvent } from "@/shared/api/types";
import { KIND_ASK_STATE } from "@/shared/constants/kinds";

/**
 * Reading relay-signed ask-state heads (kind 30200).
 *
 * One parameterized-replaceable head per Ask (`d` = the ask event id),
 * signed by the relay, carrying the `asks` projection's own `deadline_at`
 * plus a named expiry outcome. The relay is the only thing that can compute
 * that deadline (the window comes from the ask's content or the company
 * profile, then gets clamped), so this is a read path, never a recompute:
 * a countdown that disagrees with the sweep is worse than none.
 *
 * `onExpiry` is the field that matters most on a spend ask. NIP-IQ's hard
 * list forbids a `default_option` on `spend`, `hiring`, `legal` and the rest,
 * so those asks expire to `"rearms"` — the relay pushes the deadline out and
 * waits again, forever, until a human answers. That is deliberate, and it is
 * the reason this head has to be visible: an owner who never opens the ask
 * has a campaign parked indefinitely with nothing on screen saying so.
 *
 * Parsing mirrors `buzz_core::interrupt::parse_ask_state`: unknown content
 * fields are ignored so a newer relay can add them, integer fields are read
 * strictly and non-negative, and anything malformed yields null rather than a
 * partially-trusted record.
 */

/** Lifecycle status of the Ask a head describes. */
export type AskStateStatus = "open" | "resolved" | "withdrawn" | "promoted";

/** What the relay does when an open Ask's deadline passes. */
export type AskExpiryAction = "default_executes" | "promotes" | "rearms";

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
  /** When the sweep last pushed the deadline out. Null if never re-armed. */
  rearmedAt: number | null;
};

const HEX64 = /^[0-9a-f]{64}$/;

const STATUSES: readonly AskStateStatus[] = [
  "open",
  "resolved",
  "withdrawn",
  "promoted",
];

const EXPIRY_ACTIONS: readonly AskExpiryAction[] = [
  "default_executes",
  "promotes",
  "rearms",
];

function optionalNonNegativeInt(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function singleTagValue(event: RelayEvent, name: string): string | null {
  const values = (event.tags ?? [])
    .filter((tag) => tag[0] === name)
    .map((tag) => tag[1]);
  // Duplicates fail closed, the same rule the resolution parser follows: a
  // head naming two different asks describes neither of them.
  return values.length === 1 ? (values[0] ?? null) : null;
}

/**
 * Parse one kind-30200 event into an {@link AskState}, or null when it is not
 * a well-formed head signed by `relaySelfPubkey`.
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

  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (
    typeof content !== "object" ||
    content === null ||
    Array.isArray(content)
  ) {
    return null;
  }
  const record = content as Record<string, unknown>;

  const rawStatus = record.status;
  const status = STATUSES.find((candidate) => candidate === rawStatus);
  if (status === undefined) return null;

  const rawExpiry = record.on_expiry;
  const onExpiry =
    EXPIRY_ACTIONS.find((candidate) => candidate === rawExpiry) ?? null;
  const defaultOption =
    typeof record.default_option === "string" && record.default_option !== ""
      ? record.default_option
      : null;

  return {
    askId,
    status,
    deadlineAt: optionalNonNegativeInt(record.deadline_at),
    onExpiry,
    defaultOption,
    rearmedAt: optionalNonNegativeInt(record.rearmed_at),
  };
}

/**
 * Latest head per ask id, keyed by ask id.
 *
 * The relay writes NIP-33 parameterized-replaceable heads, so the relay
 * itself already resolves latest-wins — but a client that queried before a
 * replacement propagated can still hold both, so this keeps the newer
 * `created_at` rather than whichever arrived last in the array.
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

/** How long until `deadlineAt`, in coarse words. Null once it has passed. */
function untilLabel(deadlineAt: number, nowSeconds: number): string | null {
  const remaining = deadlineAt - nowSeconds;
  if (remaining <= 0) return null;
  if (remaining < 60) return "under a minute";
  const minutes = Math.floor(remaining / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)} days`;
}

/** Whole days between two timestamps, floored at zero. */
function daysBetween(fromSeconds: number, toSeconds: number): number {
  return Math.max(0, Math.floor((toSeconds - fromSeconds) / 86_400));
}

/**
 * One sentence describing what the relay will do about this ask, or null when
 * there is nothing worth saying (a closed ask, or a head with no deadline).
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
  const until = untilLabel(state.deadlineAt, nowSeconds);

  if (state.onExpiry === "default_executes" && state.defaultOption !== null) {
    return until === null
      ? `The deadline has passed; "${state.defaultOption}" applies on the next sweep.`
      : `Unanswered in ${until}, "${state.defaultOption}" applies automatically.`;
  }
  if (state.onExpiry === "promotes") {
    return until === null
      ? "The deadline has passed; this moves up a rung on the next sweep."
      : `Unanswered in ${until}, this moves up a rung.`;
  }
  if (state.onExpiry === "rearms") {
    const waitingDays = daysBetween(askCreatedAt, nowSeconds);
    const waiting =
      waitingDays >= 1
        ? ` Waiting ${waitingDays} day${waitingDays === 1 ? "" : "s"} so far.`
        : "";
    return `This will not resolve on its own: nothing happens until you answer.${waiting}`;
  }
  return null;
}
