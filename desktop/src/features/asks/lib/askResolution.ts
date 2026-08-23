import type { OpenAsk } from "@/features/asks/lib/askEvent";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_ASK_RESOLUTION } from "@/shared/constants/kinds";

/**
 * Reading ask resolutions (kind 44301).
 *
 * A resolution closes one ask. It is either a HUMAN ANSWER, signed by the
 * ask's audience or an owner (`{answer: {decision, rationale}}`), or an
 * EXECUTED DEFAULT, signed by the relay itself after the deadline passed
 * with nobody answering (`{answer: {option}, default_executed: true}` --
 * see `interrupt_runtime::execute_default`).
 *
 * Everywhere a resolution is shown, that difference must be visible: an
 * executed default is the owner's own silence acting on their behalf, and
 * passing it off as an ordinary answer would hide the one decision nobody
 * actually made. Defaults are NOT limited to decision or question asks:
 * any owner-addressed ask that states a default fires it, so copy must
 * never describe this as "decisions answering themselves".
 *
 * Parsing mirrors the relay's `buzz_core::interrupt::parse_resolution`
 * exactly: one hex64 `e` tag naming the ask (duplicates fail closed), any
 * JSON content object, and `default_executed` read strictly as a boolean.
 */

export type AskResolution = {
  /** The resolution event's own id. */
  eventId: string;
  /** The ask this resolution closes (the single `e` tag value). */
  askId: string;
  /** The signer: the relay for an executed default, a human otherwise. */
  resolverPubkey: string;
  /** Event timestamp (seconds since epoch). */
  createdAt: number;
  /**
   * True when the relay executed the stated default after the deadline
   * passed unanswered.
   */
  defaultExecuted: boolean;
  /** The option the default applied; null for human answers or unreadable. */
  appliedOption: string | null;
  /** What a human decided; null on defaults or answers without text. */
  decision: string | null;
  /** A human answer's optional reasoning. */
  rationale: string | null;
};

type AskEventShape = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags?: string[][];
};

/** A lowercase hex string of exactly 64 characters (an event id). */
const HEX64 = /^[0-9a-f]{64}$/;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Read one resolution off a relay event, or null when it is not a
 * resolution or cannot be rendered. Never throws: one malformed event must
 * not blank the surface showing what happened to people's asks.
 */
export function readAskResolution(event: AskEventShape): AskResolution | null {
  if (event.kind !== KIND_ASK_RESOLUTION) return null;
  const eTags = (event.tags ?? []).filter(
    (tag) => typeof tag[1] === "string" && tag[1].trim() !== "",
  );
  if (eTags.length !== 1) return null;
  const askId = eTags[0][1]?.trim().toLowerCase() ?? "";
  if (!HEX64.test(askId)) return null;
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
  const answer =
    fields.answer !== null &&
    typeof fields.answer === "object" &&
    !Array.isArray(fields.answer)
      ? (fields.answer as Record<string, unknown>)
      : {};
  return {
    eventId: event.id,
    askId,
    resolverPubkey: event.pubkey,
    createdAt: event.created_at,
    defaultExecuted: fields.default_executed === true,
    appliedOption: nonEmptyString(answer.option),
    decision: nonEmptyString(answer.decision),
    rationale: nonEmptyString(answer.rationale),
  };
}

/**
 * Parse every readable resolution, newest first. Malformed events drop.
 */
export function askResolutionsFromEvents(
  events: RelayEvent[],
): AskResolution[] {
  return events
    .map(readAskResolution)
    .filter((resolution): resolution is AskResolution => resolution !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The plain account of how one ask closed. This is the copy every
 * resolution surface renders: an executed default says outright that
 * nobody answered and the deadline passed, and names the option that was
 * applied; a human answer credits the person who answered it.
 */
export function describeAskResolution(
  resolution: AskResolution,
  resolverLabel: string | null,
): string {
  if (resolution.defaultExecuted) {
    const suffix = resolution.appliedOption
      ? ` The stated default was applied: ${resolution.appliedOption}.`
      : " The stated default was applied.";
    return `Nobody answered before the deadline passed.${suffix}`;
  }
  const who = resolverLabel?.trim() || "Someone";
  return resolution.decision
    ? `${who} answered before the deadline: ${resolution.decision}`
    : `${who} answered before the deadline.`;
}

/** Short status label for list rows: visibly different per closer kind. */
export function askResolutionStatusLabel(resolution: AskResolution): string {
  return resolution.defaultExecuted ? "Default executed" : "Answered";
}

/** One closed ask joined with the resolution that closed it. */
export type ResolvedAsk = {
  resolution: AskResolution;
  ask: OpenAsk;
};

/**
 * Pair resolutions with their asks, keeping only the newest resolution per
 * ask and dropping asks we could not read. Pure; newest first.
 */
export function pairResolutionsWithAsks(
  resolutions: readonly AskResolution[],
  asks: readonly OpenAsk[],
): ResolvedAsk[] {
  const askById = new Map(asks.map((ask) => [ask.id, ask]));
  const newestPerAsk = new Map<string, AskResolution>();
  for (const resolution of resolutions) {
    const existing = newestPerAsk.get(resolution.askId);
    if (!existing || resolution.createdAt > existing.createdAt) {
      newestPerAsk.set(resolution.askId, resolution);
    }
  }
  const paired: ResolvedAsk[] = [];
  for (const [askId, resolution] of newestPerAsk) {
    const ask = askById.get(askId);
    if (ask) paired.push({ resolution, ask });
  }
  paired.sort((a, b) => b.resolution.createdAt - a.resolution.createdAt);
  return paired;
}
