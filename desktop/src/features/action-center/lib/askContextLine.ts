import { effectiveFilerPubkey } from "@/features/asks/lib/askRouting";
import type { OpenAsk } from "@/features/asks/lib/askEvent";
import { formatDurationCoarse } from "./durationFormat";

/**
 * Turns a raw initiative id into a readable label: hyphens/underscores
 * become spaces, first letter capitalized. There is no separate initiative
 * name registry in this codebase -- agents write the `initiative` tag as
 * the identifier itself, so this is the whole of "resolving" it.
 */
export function formatInitiativeLabel(initiativeId: string): string {
  const words = initiativeId
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words.length === 0) return initiativeId;
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

/**
 * The context line for an ask item (spec: "who asked, initiative, blast
 * radius"): "Ask from <name> · initiative: <label> · blocks N tasks". The
 * initiative clause is omitted for the `no-initiative` sentinel (chat-
 * derived work has nothing to name), and blast radius is omitted when an
 * ask blocks only one task -- "blocks 1 tasks" is not worth a reader's time.
 *
 * `askerLabel` is resolved by the caller (a pubkey-to-name batch lookup);
 * this function only formats, it never resolves.
 */
export function buildAskContextLine(
  ask: Pick<
    OpenAsk,
    "filerPubkey" | "originalFilerPubkey" | "initiativeId" | "taskIds"
  >,
  askerLabel: string,
): string {
  const parts = [`Ask from ${askerLabel}`];
  if (ask.initiativeId && ask.initiativeId !== "no-initiative") {
    parts.push(`initiative: ${formatInitiativeLabel(ask.initiativeId)}`);
  }
  if (ask.taskIds.length > 1) {
    parts.push(`blocks ${ask.taskIds.length} tasks`);
  }
  return parts.join(" · ");
}

/** The asker pubkey a context line names -- exported so callers can batch-resolve labels without duplicating this choice. */
export function askContextSubjectPubkey(
  ask: Pick<OpenAsk, "filerPubkey" | "originalFilerPubkey">,
): string {
  return effectiveFilerPubkey(ask);
}

/** The minimal shape of a fetched-and-parsed prior ask this needs. */
export type PriorAskProvenance = {
  audiencePubkey: string | null;
  createdAt: number;
};

/**
 * Escalation provenance (spec, resolved question 5): "escalated
 * automatically; sat with <prior audience> for <duration>". Null when the
 * ask carries no `prior` tag, or when the prior ask could not be fetched
 * (relay miss) -- silence rather than a guess, matching this epic's
 * fail-closed convention for anything requiring a lookup that did not land.
 *
 * Duration is how long the prior ask existed before this one superseded it:
 * this ask's own `createdAt` minus the prior ask's `createdAt`, clamped to
 * zero so a clock anomaly never prints a negative duration.
 */
export function buildEscalationLine(
  thisAskCreatedAt: number,
  priorAsk: PriorAskProvenance | null,
  priorAudienceLabel: string | null,
): string | null {
  if (!priorAsk) return null;
  const audience = priorAudienceLabel?.trim() || "the prior audience";
  const duration = formatDurationCoarse(thisAskCreatedAt - priorAsk.createdAt);
  return `escalated automatically; sat with ${audience} for ${duration}`;
}
