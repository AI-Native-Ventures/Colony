import { KIND_ASK } from "@/shared/constants/kinds";

/** An open ask addressed to the signed-in owner. */
export type OpenAsk = {
  id: string;
  askType: string;
  headline: string;
  costOfDelay: string | null;
  filerPubkey: string;
  createdAt: number;
};

type AskEventShape = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
};

/**
 * Read an ask off a relay event, or null when it is not an ask or cannot be
 * rendered. Never throws: one malformed ask must not blank the whole surface.
 */
export function readAsk(event: AskEventShape): OpenAsk | null {
  if (event.kind !== KIND_ASK) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const fields = parsed as Record<string, unknown>;
  const headline =
    typeof fields.headline === "string" ? fields.headline.trim() : "";
  if (!headline) return null;
  return {
    id: event.id,
    askType: typeof fields.type === "string" ? fields.type : "question",
    headline,
    costOfDelay:
      typeof fields.cost_of_delay === "string" ? fields.cost_of_delay : null,
    filerPubkey: event.pubkey,
    createdAt: event.created_at,
  };
}

/**
 * The asks still waiting on the owner: everything with no closure event
 * naming it, newest first.
 *
 * An ask a leader or executive already answered must never appear here. That
 * absorption is the entire point of the ladder, and showing an answered ask
 * would put the founder back in a loop the chain just took them out of.
 */
export function selectOpenAsks(
  asks: OpenAsk[],
  closureEventIds: string[],
): OpenAsk[] {
  const closed = new Set(closureEventIds);
  return asks
    .filter((ask) => !closed.has(ask.id))
    .sort((a, b) => b.createdAt - a.createdAt);
}
