import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_DECISION_LOG } from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";

/**
 * Reading decision logs (kind 44303).
 *
 * A decision log is a leader or executive recording a decision it made on
 * its own authority under a delegation grant, with the undo path attached:
 * reversibility is the license for autonomy, so no stateable undo path means
 * no autonomy and the relay refuses such an event at ingest.
 *
 * Trust mirrors what the relay actually enforces, and differs from the
 * grants layer on purpose. Kind 30189 heads are client-writable, so the
 * grants reader must scan candidates newest-first and take the first
 * OWNER-authored head per d tag. A decision log has no head to forge past:
 * ingest (`buzz-relay::interrupt_gate::enforce_decision_log_authority`)
 * rejects anything whose signer is not currently Leader or Executive rank,
 * whose cited grant does not resolve to a currently ACTIVE owner-authored
 * head, whose category differs from that grant's category, or whose amount
 * violates the grant's cap -- and malformed logs are refused outright rather
 * than stored (`handlers::ingest`). So every kind-44303 event this client
 * fetches was already vetted at write time and is authored by the DECIDING
 * AGENT itself. There is deliberately NO authorship filter here: copying the
 * grants layer's owner-authorship scan would hide every legitimate log,
 * because none of them are owner-authored.
 */

export type DecisionLog = {
  /** The log event's own id. */
  eventId: string;
  /** The deciding agent: the signer, a leader or executive at write time. */
  agentPubkey: string;
  /** Event timestamp (seconds since epoch). */
  createdAt: number;
  /** The `grant` tag: the delegation grant this decision was made under. */
  grantId: string;
  /** All `task` tag values: the task(s) this decision covers. */
  taskIds: string[];
  /** What was decided. */
  decision: string;
  /**
   * How to undo this decision. Required by the relay; the only field the
   * owner acts on, so surfaces render it as primary content.
   */
  undoPath: string;
  /** What kind of decision this claims to be (lowercased). */
  category: string;
  /** The money this decision moves, in integer nanoUSD, when it moves any. */
  amountNanoUsd: number | null;
};

/**
 * Parse one decision log event, or null when it cannot be rendered. Never
 * throws: one malformed record must not blank the surface. The relay stores
 * only vetted logs, so this is defense in depth against mesh relays or mock
 * data, not a re-litigation of authority.
 */
export function parseDecisionLogEvent(event: RelayEvent): DecisionLog | null {
  if (event.kind !== KIND_DECISION_LOG) return null;

  // Exactly one `grant` tag, fail closed on duplicates or blanks -- same
  // single-tag semantics as the relay's ask parser (`single_tag_value`).
  const grantMatches = event.tags.filter(
    (tag) => tag[0] === "grant" && typeof tag[1] === "string",
  );
  if (grantMatches.length !== 1) return null;
  const grantId = grantMatches[0][1]?.trim();
  if (!grantId) return null;

  const taskIds = event.tags
    .filter((tag) => tag[0] === "task" && typeof tag[1] === "string")
    .map((tag) => tag[1]?.trim() ?? "")
    .filter((taskId) => taskId !== "");
  if (taskIds.length === 0) return null;

  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.content) as Record<string, unknown>;
  } catch {
    return null;
  }

  const readRequiredString = (key: string): string | null => {
    const value = content[key];
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  };
  const decision = readRequiredString("decision");
  const undoPath = readRequiredString("undo_path");
  const rawCategory = readRequiredString("category");
  if (!decision || !undoPath || !rawCategory) return null;
  const category = rawCategory.toLowerCase();

  let amountNanoUsd: number | null = null;
  const rawAmount = content.amount_nano_usd;
  if (rawAmount !== undefined) {
    if (
      typeof rawAmount !== "number" ||
      !Number.isInteger(rawAmount) ||
      rawAmount < 0
    ) {
      return null;
    }
    amountNanoUsd = rawAmount;
  }

  return {
    eventId: event.id,
    agentPubkey: normalizePubkey(event.pubkey),
    createdAt: event.created_at,
    grantId,
    taskIds,
    decision,
    undoPath,
    category,
    amountNanoUsd,
  };
}

/** Parse every readable log, newest first. Malformed entries are dropped. */
export function decisionLogsFromEvents(events: RelayEvent[]): DecisionLog[] {
  return events
    .map(parseDecisionLogEvent)
    .filter((log): log is DecisionLog => log !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export type DecisionLogFilters = {
  /** Keep only this deciding agent's logs. Empty string means no filter. */
  agentPubkey?: string;
  /** Keep only logs made under this grant id. Case-insensitive. */
  grantId?: string;
  /** Keep only logs in this category. Case-insensitive. */
  category?: string;
};

/** Apply the view's agent / grant / category filters. Pure. */
export function filterDecisionLogs(
  logs: readonly DecisionLog[],
  filters: DecisionLogFilters,
): DecisionLog[] {
  const agent = filters.agentPubkey
    ? normalizePubkey(filters.agentPubkey)
    : null;
  const grant = filters.grantId?.trim().toLowerCase() || null;
  const category = filters.category?.trim().toLowerCase() || null;
  return logs.filter((log) => {
    if (agent && log.agentPubkey !== agent) return false;
    if (grant && log.grantId.toLowerCase() !== grant) return false;
    if (category && log.category.toLowerCase() !== category) return false;
    return true;
  });
}

async function fetchDecisionLogEvents(): Promise<RelayEvent[]> {
  const filter: RelaySubscriptionFilter = {
    kinds: [KIND_DECISION_LOG],
    limit: 500,
  };
  return relayClient.fetchEvents(filter);
}

const DECISION_LOGS_ROOT = "colony-decision-logs" as const;

/** Community-scoped query key for the raw kind-44303 fetch. */
export function decisionLogsQueryKey(communityId: string) {
  return [DECISION_LOGS_ROOT, communityId] as const;
}

export { fetchDecisionLogEvents };
