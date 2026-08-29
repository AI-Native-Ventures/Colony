import { KIND_ASK } from "@/shared/constants/kinds";
import type { AskState, AskStateStatus } from "./askState";

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
  /**
   * All `task` tag values, one or more per the relay's `MissingTaskTag`
   * requirement (`parse_ask`). Blast radius (Ranking tier 2) is this array's
   * length: the relay's own dedupe means one ask can carry several `task`
   * tags when it blocks several tasks/agents on the same need, and the
   * count is read raw here exactly as `ParsedAsk.task_ids` is (no dedup at
   * parse time on either side).
   */
  taskIds: readonly string[];
  /**
   * The optional `category` tag, case PRESERVED as filed (NIP-IQ: matched
   * case-insensitively against the hard list, never case-folded at parse
   * time for an ask). Null when absent or ambiguous (2+ occurrences).
   */
  category: string | null;
  /** The content `default_option` field: the answer the relay applies if the
   * deadline passes with nobody answering. Null when this ask has none. */
  defaultOption: string | null;
  /** The content `default_window_secs` field: seconds from filing until the
   * default applies. Null when absent -- the broker falls back to the
   * community's `ask_window_secs`, then 3600s; see `lib/askDeadline.ts`. */
  defaultWindowSecs: number | null;
  /**
   * The `initiative` tag value. The relay requires exactly one, using the
   * reserved value `"no-initiative"` (`buzz_core::interrupt::NO_INITIATIVE`)
   * for chat-derived work with no initiative -- so this is only null when an
   * ask cannot be read at all through some other malformation, never a
   * legitimate "no initiative" state.
   */
  initiativeId: string | null;
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
 * Read a single-valued tag whose case matters (`category`, `initiative`),
 * mirroring `optional_tag_value`'s cardinality rule (exactly one occurrence,
 * else unreadable) without `singleRoutingTag`'s lowercasing -- the relay
 * never case-folds these tags at parse time, only at comparison time.
 */
function singleTagPreservingCase(
  tags: string[][],
  name: string,
): string | null {
  const matches = tags.filter(
    (tag) =>
      tag[0] === name && typeof tag[1] === "string" && tag[1].trim() !== "",
  );
  if (matches.length !== 1) return null;
  return matches[0][1]?.trim() ?? null;
}

/**
 * All values of an exact two-element tag named `name`, mirroring the
 * relay's `tag_values` (`buzz_core::interrupt`): no dedup, no trimming, no
 * cardinality limit. Used for `task`, where the relay's own ask dedupe means
 * a legitimate ask carries several.
 */
function allTagValues(tags: string[][], name: string): string[] {
  return tags
    .filter((tag) => tag.length === 2 && tag[0] === name)
    .map((tag) => tag[1]);
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
  const defaultOption =
    typeof fields.default_option === "string" ? fields.default_option : null;
  const defaultWindowSecsRaw = fields.default_window_secs;
  const defaultWindowSecs =
    typeof defaultWindowSecsRaw === "number" &&
    Number.isInteger(defaultWindowSecsRaw) &&
    defaultWindowSecsRaw >= 0
      ? defaultWindowSecsRaw
      : null;
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
    taskIds: allTagValues(tags, "task"),
    category: singleTagPreservingCase(tags, "category"),
    defaultOption,
    defaultWindowSecs,
    initiativeId: singleTagPreservingCase(tags, "initiative"),
  };
}

/**
 * Ask-state statuses that mean the relay itself no longer considers the ask
 * open. `promoted` is included deliberately: the old row's audience is no
 * longer the person to act on it, and the relay files a successor addressed
 * one rung up as its own new open ask.
 */
const CLOSED_ASK_STATE_STATUSES: ReadonlySet<AskStateStatus> = new Set([
  "resolved",
  "withdrawn",
  "promoted",
]);

/**
 * The asks still waiting on the owner, newest first. Excluded by two
 * independent signals, kept both rather than either alone:
 *
 * - `closureEventIds`: a kind 44301/44302 event naming the ask (the card
 *   resolution/withdrawal path, which always publishes one of these).
 * - `askStatesById`: the ask's relay-signed state head (kind 30200),
 *   status `resolved`/`withdrawn`/`promoted`. This is the ONLY signal an
 *   ask closed by an owner's thread reply produces
 *   (`buzz-relay/src/ask_broker.rs`'s `try_auto_resolve_from_reply` closes
 *   the row and republishes the state head, but never publishes a 44301 or
 *   44302 — the reply itself, not a resolution card, is the record). A
 *   caller that skips `askStatesById` will keep showing a thread-resolved
 *   ask as open forever.
 *
 * `askStatesById` MUST already be trust-filtered to heads authored by the
 * relay's own pubkey before it reaches here (see `askStatesFromEvents` in
 * `./askState.ts`, which every caller of this function goes through) — this
 * function does no pubkey check of its own. A head from any other signer is
 * a forgery claiming a state the relay never set: trusting one here would
 * let any authenticated member hide an ask from the owner's queue simply by
 * publishing a state head naming it closed, defeating the exact protocol
 * boundary this surface exists to enforce.
 *
 * An ask a leader or executive already answered must never appear here. That
 * absorption is the entire point of the ladder, and showing an answered ask
 * would put the founder back in a loop the chain just took them out of.
 */
export function selectOpenAsks(
  asks: OpenAsk[],
  closureEventIds: string[],
  askStatesById: ReadonlyMap<string, AskState> = new Map(),
): OpenAsk[] {
  const closed = new Set(closureEventIds);
  return asks
    .filter((ask) => !closed.has(ask.id))
    .filter((ask) => {
      const state = askStatesById.get(ask.id);
      return (
        state === undefined || !CLOSED_ASK_STATE_STATUSES.has(state.status)
      );
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}
