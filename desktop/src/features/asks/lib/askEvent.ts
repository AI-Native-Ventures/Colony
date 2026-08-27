import { KIND_ASK } from "@/shared/constants/kinds";

/** An open ask addressed to the signed-in owner. */
export type OpenAsk = {
  id: string;
  askType: string;
  headline: string;
  costOfDelay: string | null;
  filerPubkey: string;
  createdAt: number;
  rawContent: string;
  channelId: string | null;
  threadId: string | null;
  /**
   * Who the ask is addressed to (the `p` tag), or null when the event
   * carries no readable audience.
   */
  audiencePubkey: string | null;
  /**
   * The `prior` tag: set only on relay-signed promotions, naming the earlier
   * ask this one supersedes. An agent-authored ask never carries it -- the
   * relay refuses the tag on anything it did not sign itself.
   */
  priorAskId: string | null;
  /**
   * The `filer` tag on a relay-signed promotion: the ORIGINAL filer carried
   * forward, since this event's own pubkey is the relay, not the blocked
   * agent. Null on ordinary asks.
   */
  originalFilerPubkey: string | null;
};

type AskEventShape = {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  content: string;
  tags?: string[][];
};

/** A lowercase hex string of exactly 64 characters (a pubkey or event id). */
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The pinned `ask-type` vocabulary (`buzz_core::interrupt::AskType`). Anything
 * outside it is rejected at ingest, so an unrecognized value here means the
 * event did not come through the relay's parser.
 */
const ASK_TYPES: ReadonlySet<string> = new Set([
  "decision",
  "question",
  "credential",
  "blocker",
  "stall",
]);

/**
 * Read a single-valued routing tag, mirroring the relay's ask parser
 * (`buzz_core::interrupt::parse_ask` via `single_tag_value`): the FIRST
 * occurrence supplies the value, and a duplicate means the tag is
 * UNREADABLE -- fail closed to null, never first-wins.
 */
function singleRoutingTag(tags: string[][], name: string): string | null {
  const matches = tags.filter(
    (tag) =>
      tag[0] === name && typeof tag[1] === "string" && tag[1].trim() !== "",
  );
  if (matches.length !== 1) return null;
  return matches[0][1]?.trim().toLowerCase() ?? null;
}

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
  const tags = event.tags ?? [];
  const sourceTag = (name: string) =>
    tags
      .find(
        (tag) =>
          tag[0] === name && typeof tag[1] === "string" && tag[1].trim() !== "",
      )?.[1]
      ?.trim() ?? null;
  // Routing provenance is hex64 or nothing, exactly as the relay validates
  // it at ingest (`validate_hex64_field`).
  const audienceTag = singleRoutingTag(tags, "p");
  const priorTag = singleRoutingTag(tags, "prior");
  const filerTag = singleRoutingTag(tags, "filer");
  const channelId = sourceTag("h");
  const threadId = sourceTag("e");
  // NIP-IQ carries the ask type on the `ask-type` TAG, not in content, and
  // requires exactly one occurrence. Reading `content.type` was wrong: no ask
  // the CLI or relay files has such a field, so every real ask rendered as
  // "question" regardless of what it actually was. The content field stays as
  // a fallback only so older fixtures keep resolving.
  const askTypeTag = singleRoutingTag(tags, "ask-type");
  const askType =
    askTypeTag !== null && ASK_TYPES.has(askTypeTag)
      ? askTypeTag
      : typeof fields.type === "string" && ASK_TYPES.has(fields.type)
        ? fields.type
        : "question";
  return {
    id: event.id,
    askType,
    headline,
    costOfDelay:
      typeof fields.cost_of_delay === "string" ? fields.cost_of_delay : null,
    filerPubkey: event.pubkey,
    createdAt: event.created_at,
    rawContent: event.content,
    channelId: channelId?.trim() || null,
    threadId: threadId?.trim() || null,
    audiencePubkey:
      audienceTag !== null && HEX64.test(audienceTag) ? audienceTag : null,
    priorAskId: priorTag !== null && HEX64.test(priorTag) ? priorTag : null,
    originalFilerPubkey:
      filerTag !== null && HEX64.test(filerTag) ? filerTag : null,
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
