/**
 * One agent handing work to another, on Colony's wire.
 *
 * Colony has no "a reply is expected" marker of its own: nothing in
 * `buzz-core`, `buzz-sdk` or `buzz-acp` carries one, and NIP-IQ's Asks are
 * agent-to-owner escalations rather than agent-to-agent work. So a delegation
 * is an ordinary stream message that mentions the delegate and carries a
 * `["client", "colony-delegation", <json>]` marker beside it — the same shape
 * onboarding already uses for its own markers, and the only tag channel
 * `send_channel_message` will accept from the frontend.
 *
 * The marker names both sides, because the message is signed by the *owner*
 * (the person clicking Send in the dialog), not by the delegating agent: the
 * author tells you nothing about who delegated. Without it a tile could not
 * tell "I delegated this" from "this was delegated to me".
 *
 * The expectation is also written into the body as a trailing line, so an
 * agent reading the message as plain text sees it too — the harness never
 * shows tags to the model.
 */

/** Marker naming a delegation message. */
export const DELEGATION_CLIENT_MARKER = "colony-delegation";

/** Trailing line stating the expectation in the body the agent reads. */
export const REPLY_EXPECTED_LINE = "A reply is expected.";

export type DelegationPayload = {
  /** Pubkey of the agent doing the delegating. */
  from: string;
  /** Pubkey of the agent being delegated to. */
  to: string;
  replyExpected: boolean;
};

/** Minimal event shape the derivation needs; a relay event satisfies it. */
export type DelegationEvent = {
  id: string;
  content: string;
  tags: string[][];
  created_at?: number;
};

/** The body actually posted: the brief, plus the expectation when it applies. */
export function buildDelegationContent(
  body: string,
  replyExpected: boolean,
): string {
  const trimmed = body.trim();
  if (!replyExpected) return trimmed;
  return `${trimmed}\n\n${REPLY_EXPECTED_LINE}`;
}

/** The `clientTags` a delegation message carries. */
export function delegationClientTags(payload: DelegationPayload): string[][] {
  return [
    [
      "client",
      DELEGATION_CLIENT_MARKER,
      JSON.stringify({
        from: payload.from,
        to: payload.to,
        replyExpected: payload.replyExpected,
      }),
    ],
  ];
}

/** Read a delegation marker back off an event, or null when it carries none. */
export function readDelegationPayload(
  event: DelegationEvent,
): DelegationPayload | null {
  const tag = event.tags.find(
    (candidate) =>
      candidate[0] === "client" && candidate[1] === DELEGATION_CLIENT_MARKER,
  );
  if (!tag || typeof tag[2] !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tag[2]);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const from = record.from;
  const to = record.to;
  if (typeof from !== "string" || !from) return null;
  if (typeof to !== "string" || !to) return null;
  return { from, to, replyExpected: record.replyExpected === true };
}

export type DelegationCard = {
  /** `"outgoing"` on the delegator's tile, `"incoming"` on the delegate's. */
  direction: "outgoing" | "incoming";
  eventId: string;
  /** The other agent in this delegation. */
  counterpartPubkey: string;
  counterpartName: string;
  replyExpected: boolean;
  /** "Delegated to Vera · reply expected" / "From Avery · reply expected". */
  label: string;
  /** The delegated brief, with the expectation line stripped off. */
  body: string;
};

/** Strip the trailing expectation line the card states in its own header. */
function cardBody(content: string): string {
  const trimmed = content.trim();
  if (!trimmed.endsWith(REPLY_EXPECTED_LINE)) return trimmed;
  return trimmed.slice(0, -REPLY_EXPECTED_LINE.length).trim();
}

/**
 * The delegation cards one agent's tile shows, oldest first.
 *
 * Scoped to a single agent: the same thread carries both halves of a
 * delegation, and each tile shows only its own side of it.
 */
export function deriveDelegationCards({
  events,
  agentPubkey,
  nameFor,
}: {
  events: readonly DelegationEvent[];
  agentPubkey: string;
  nameFor: (pubkey: string) => string;
}): DelegationCard[] {
  const self = agentPubkey.trim().toLowerCase();
  if (!self) return [];
  const cards: DelegationCard[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const payload = readDelegationPayload(event);
    if (!payload || seen.has(event.id)) continue;
    const from = payload.from.toLowerCase();
    const to = payload.to.toLowerCase();
    const direction =
      from === self ? "outgoing" : to === self ? "incoming" : null;
    if (direction === null) continue;
    seen.add(event.id);
    const counterpartPubkey =
      direction === "outgoing" ? payload.to : payload.from;
    const counterpartName = nameFor(counterpartPubkey);
    const suffix = payload.replyExpected ? " · reply expected" : "";
    cards.push({
      direction,
      eventId: event.id,
      counterpartPubkey,
      counterpartName,
      replyExpected: payload.replyExpected,
      label:
        direction === "outgoing"
          ? `Delegated to ${counterpartName}${suffix}`
          : `From ${counterpartName}${suffix}`,
      body: cardBody(event.content),
    });
  }
  return cards;
}
