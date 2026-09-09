import { businessTextLength } from "./businessContextLimits";

export const FIRST_JOB_SUGGESTION_MARKER = "colony:first-job-suggestion:v1";

/** Setup data owned by the founder. Reading this tag never starts agent work. */
export type FirstJobSuggestion = {
  version: 1;
  ownerPubkey: string;
  relayUrl: string;
  channelId: string;
  requestId: string;
  businessName: string;
  business: string;
  website: string;
  brief: string;
};

const HEX_ID = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_PAYLOAD_LENGTH = 16_384;

function text(
  value: unknown,
  maximum: number,
  required = true,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    (!required || value.trim().length > 0) &&
    !value.includes("\u0000")
  );
}

function safeUrl(value: string, protocols: string[]): boolean {
  try {
    const url = new URL(value);
    return (
      protocols.includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isSuggestion(value: unknown): value is FirstJobSuggestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === 1 &&
    typeof item.ownerPubkey === "string" &&
    HEX_ID.test(item.ownerPubkey) &&
    text(item.relayUrl, 2048) &&
    safeUrl(item.relayUrl, ["wss:", "ws:"]) &&
    typeof item.channelId === "string" &&
    SAFE_ID.test(item.channelId) &&
    typeof item.requestId === "string" &&
    SAFE_ID.test(item.requestId) &&
    text(item.businessName, 200) &&
    text(item.business, 12000, false) &&
    businessTextLength(item.business) <= 6000 &&
    text(item.website, 2048, false) &&
    (!item.website || safeUrl(item.website, ["https:", "http:"])) &&
    text(item.brief, 4000)
  );
}

/** One unambiguous versioned tag; malformed data falls back to normal Markdown. */
export function parseFirstJobSuggestion(
  tags: readonly string[][] | null | undefined,
): FirstJobSuggestion | null {
  const matches = tags?.filter(
    (tag) => tag[0] === "client" && tag[1] === FIRST_JOB_SUGGESTION_MARKER,
  );
  if (matches?.length !== 1) return null;
  const tag = matches[0];
  const json = tag?.[2];
  if (tag?.length !== 3 || !json || json.length > MAX_PAYLOAD_LENGTH)
    return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!isSuggestion(value)) return null;
    // Copy only supported fields. Unknown data never becomes adapter options.
    return {
      version: 1,
      ownerPubkey: value.ownerPubkey,
      relayUrl: value.relayUrl,
      channelId: value.channelId,
      requestId: value.requestId,
      businessName: value.businessName,
      business: value.business,
      website: value.website,
      brief: value.brief,
    };
  } catch {
    return null;
  }
}

/** Encode bounded setup data using the existing channel-message client tag. */
export function firstJobSuggestionTag(payload: FirstJobSuggestion): string[] {
  const tag = ["client", FIRST_JOB_SUGGESTION_MARKER, JSON.stringify(payload)];
  if (!parseFirstJobSuggestion([tag])) {
    throw new Error(
      "This setup suggestion could not be saved. Review the brief and try again.",
    );
  }
  return tag;
}

/** Other clients show the same suggestion as ordinary, readable context. */
export function firstJobSuggestionBody(payload: FirstJobSuggestion): string {
  firstJobSuggestionTag(payload);
  return [
    "**Setup suggestion**",
    payload.businessName,
    payload.business,
    payload.website ? `Website: ${payload.website}` : "",
    `**Suggested first job**\n${payload.brief}`,
    "Scout coordinates the work and brings the result back to this thread. You can edit this suggestion. Nothing starts until you choose Start.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Presentation eligibility only; native scope and staffing are checked again at Start. */
export function canStartFirstJobSuggestion(
  message: {
    id: string;
    kind?: number;
    pubkey?: string;
    signerPubkey?: string;
    pending?: boolean;
    tags?: string[][];
  },
  current: { ownerPubkey: string; relayUrl: string; channelId: string },
): boolean {
  const payload = parseFirstJobSuggestion(message.tags);
  const channels = message.tags?.filter((tag) => tag[0] === "h");
  return Boolean(
    payload &&
      !message.pending &&
      message.kind === 9 &&
      HEX_ID.test(message.id) &&
      message.signerPubkey === current.ownerPubkey &&
      message.pubkey === current.ownerPubkey &&
      payload.ownerPubkey === current.ownerPubkey &&
      payload.relayUrl === current.relayUrl &&
      payload.channelId === current.channelId &&
      channels?.length === 1 &&
      channels[0]?.[1] === current.channelId &&
      !message.tags?.some((tag) => tag[0] === "e"),
  );
}
