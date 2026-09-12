import { FIRST_JOB_SUGGESTION_MARKER } from "../firstJobSuggestion";
import type { OnboardingV2Draft } from "../onboardingV2";

/** The owner-authenticated root that opens the choice-first Welcome flow. */
export const SCOUT_ONBOARDING_ROOT_MARKER =
  "colony:scout-onboarding-root:v1" as const;
/** Nonstarting marker understood by older Welcome kickoff builds. */
export const SCOUT_ONBOARDING_LEGACY_SUPPRESSION_MARKER =
  FIRST_JOB_SUGGESTION_MARKER;
export const SCOUT_ONBOARDING_ROOT_KIND = 9 as const;
export const SCOUT_ONBOARDING_ROOT_VERSION = 1 as const;

export type ScoutOnboardingWebsiteState = "unknown" | "provided" | "none";

/** Identity and channel authority carried by every onboarding root. */
export type ScoutOnboardingRootScope = {
  ownerPubkey: string;
  relayUrl: string;
  channelId: string;
  /** The signup marker; retries must reuse this exact value. */
  requestId: string;
};

/** Signup facts that Scout may see in the private Welcome channel. */
export type ScoutOnboardingRootSeed = {
  ownerName: string;
  ownerNote: string;
  businessName: string;
  businessDescription: string;
  website: string;
  /** `none` is different from an unanswered website field. */
  websiteState: ScoutOnboardingWebsiteState;
};

/** Raw signup input accepted by the root builder. */
export type ScoutOnboardingRootSeedInput = {
  ownerName?: string | null;
  ownerNote?: string | null;
  businessName?: string | null;
  businessDescription?: string | null;
  website?: string | null;
  websiteState?: ScoutOnboardingWebsiteState | null;
  /** Used by the signup form before it has a website URL to carry. */
  hasWebsite?: boolean | null;
};

export type ScoutOnboardingRootPayload = ScoutOnboardingRootScope & {
  version: typeof SCOUT_ONBOARDING_ROOT_VERSION;
  seed: ScoutOnboardingRootSeed;
};

export const SCOUT_ONBOARDING_ROOT_STORAGE_PREFIX =
  "colony.scout-onboarding-root.v1:";

const HEX_ID = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_ROOT_PAYLOAD_LENGTH = 16_384;
const MAX_OWNER_NAME_LENGTH = 200;
const MAX_OWNER_NOTE_LENGTH = 4_000;
const MAX_BUSINESS_NAME_LENGTH = 200;
const MAX_BUSINESS_DESCRIPTION_LENGTH = 12_000;
const MAX_WEBSITE_LENGTH = 2_048;

function boundedText(value: unknown, maximum: number) {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    !value.includes("\u0000")
  );
}

function isSafeRelayUrl(value: unknown): value is string {
  if (!boundedText(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return (
      ["ws:", "wss:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isSafeWebsite(value: unknown): value is string {
  if (!boundedText(value, MAX_WEBSITE_LENGTH)) return false;
  if (value.length === 0) return true;
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function isWebsiteState(value: unknown): value is ScoutOnboardingWebsiteState {
  return value === "unknown" || value === "provided" || value === "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown, maximum: number) {
  if (!boundedText(value, maximum)) return "";
  return value.trim();
}

function resolveWebsiteState(
  input: ScoutOnboardingRootSeedInput,
  website: string,
) {
  if (input.websiteState === "none" || input.hasWebsite === false)
    return "none";
  if (input.websiteState === "provided" && website) return "provided";
  if (website) return "provided";
  return "unknown";
}

/** Normalize signup context without turning an explicit no-website answer into unknown. */
export function normalizeScoutOnboardingRootSeed(
  input: ScoutOnboardingRootSeedInput | undefined,
): ScoutOnboardingRootSeed {
  const website = normalizeText(input?.website, MAX_WEBSITE_LENGTH);
  const websiteState = resolveWebsiteState(input ?? {}, website);
  return {
    ownerName: normalizeText(input?.ownerName, MAX_OWNER_NAME_LENGTH),
    ownerNote: normalizeText(input?.ownerNote, MAX_OWNER_NOTE_LENGTH),
    businessName: normalizeText(input?.businessName, MAX_BUSINESS_NAME_LENGTH),
    businessDescription: normalizeText(
      input?.businessDescription,
      MAX_BUSINESS_DESCRIPTION_LENGTH,
    ),
    website: websiteState === "none" ? "" : website,
    websiteState,
  };
}

function isValidScope(scope: ScoutOnboardingRootScope): boolean {
  return (
    HEX_ID.test(scope.ownerPubkey) &&
    isSafeRelayUrl(scope.relayUrl) &&
    SAFE_ID.test(scope.channelId) &&
    SAFE_ID.test(scope.requestId)
  );
}

function isValidSeed(seed: ScoutOnboardingRootSeed): boolean {
  return (
    boundedText(seed.ownerName, MAX_OWNER_NAME_LENGTH) &&
    boundedText(seed.ownerNote, MAX_OWNER_NOTE_LENGTH) &&
    boundedText(seed.businessName, MAX_BUSINESS_NAME_LENGTH) &&
    boundedText(seed.businessDescription, MAX_BUSINESS_DESCRIPTION_LENGTH) &&
    isWebsiteState(seed.websiteState) &&
    isSafeWebsite(seed.website) &&
    (seed.websiteState !== "provided" || seed.website.trim().length > 0) &&
    (seed.websiteState !== "none" || seed.website.length === 0)
  );
}

/** Validate the complete wire payload before it can become a signed event. */
export function isValidScoutOnboardingRootPayload(
  value: unknown,
): value is ScoutOnboardingRootPayload {
  if (!isRecord(value) || value.version !== SCOUT_ONBOARDING_ROOT_VERSION) {
    return false;
  }
  const scope = value as Partial<ScoutOnboardingRootScope>;
  const seed = value.seed;
  return (
    typeof scope.ownerPubkey === "string" &&
    typeof scope.relayUrl === "string" &&
    typeof scope.channelId === "string" &&
    typeof scope.requestId === "string" &&
    isValidScope({
      ownerPubkey: scope.ownerPubkey,
      relayUrl: scope.relayUrl,
      channelId: scope.channelId,
      requestId: scope.requestId,
    }) &&
    isRecord(seed) &&
    typeof seed.ownerName === "string" &&
    typeof seed.ownerNote === "string" &&
    typeof seed.businessName === "string" &&
    typeof seed.businessDescription === "string" &&
    typeof seed.website === "string" &&
    isValidSeed({
      ownerName: seed.ownerName,
      ownerNote: seed.ownerNote,
      businessName: seed.businessName,
      businessDescription: seed.businessDescription,
      website: seed.website,
      websiteState: seed.websiteState as ScoutOnboardingWebsiteState,
    })
  );
}

/** Build the canonical owner-authenticated root from the signup checkpoint. */
export function createScoutOnboardingRootPayload(
  scope: ScoutOnboardingRootScope,
  input: ScoutOnboardingRootSeedInput | undefined,
): ScoutOnboardingRootPayload {
  const seed = normalizeScoutOnboardingRootSeed(input);
  const payload: ScoutOnboardingRootPayload = {
    version: SCOUT_ONBOARDING_ROOT_VERSION,
    ownerPubkey: scope.ownerPubkey,
    relayUrl: scope.relayUrl,
    channelId: scope.channelId,
    requestId: scope.requestId,
    seed,
  };
  if (!isValidScoutOnboardingRootPayload(payload)) {
    throw new Error("The signup context could not be verified. Retry setup.");
  }
  return payload;
}

/** Carry the known signup fields out of the v2 draft without carrying a task. */
export function scoutOnboardingRootSeedFromDraft(
  draft: Pick<OnboardingV2Draft, "founder" | "company">,
): ScoutOnboardingRootSeedInput {
  return {
    ownerName: draft.founder.fullName,
    businessName: draft.company.name ?? "",
    businessDescription: draft.company.summary,
    website: draft.company.canonicalUrl || draft.company.website,
    hasWebsite: draft.company.hasWebsite,
  };
}

export function scoutOnboardingRootTag(
  payload: ScoutOnboardingRootPayload,
): string[] {
  if (!isValidScoutOnboardingRootPayload(payload)) {
    throw new Error("The signup root is invalid.");
  }
  const json = JSON.stringify(payload);
  if (json.length > MAX_ROOT_PAYLOAD_LENGTH) {
    throw new Error("The signup context is too large to save.");
  }
  return ["client", SCOUT_ONBOARDING_ROOT_MARKER, json];
}

/** Add the old two-field marker so pre-choice clients suppress automatic kickoff safely. */
export function scoutOnboardingRootTags(
  payload: ScoutOnboardingRootPayload,
): string[][] {
  return [
    ["h", payload.channelId],
    ["client", SCOUT_ONBOARDING_LEGACY_SUPPRESSION_MARKER],
    scoutOnboardingRootTag(payload),
  ];
}

/** Parse only this protocol's tag and copy supported fields out of untrusted JSON. */
export function parseScoutOnboardingRoot(
  tags: readonly string[][] | null | undefined,
): ScoutOnboardingRootPayload | null {
  const matches = tags?.filter(
    (tag) => tag[0] === "client" && tag[1] === SCOUT_ONBOARDING_ROOT_MARKER,
  );
  if (matches?.length !== 1) return null;
  const tag = matches[0];
  const json = tag?.[2];
  if (tag?.length !== 3 || !json || json.length > MAX_ROOT_PAYLOAD_LENGTH) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(json);
    if (!isValidScoutOnboardingRootPayload(value)) return null;
    return {
      version: SCOUT_ONBOARDING_ROOT_VERSION,
      ownerPubkey: value.ownerPubkey,
      relayUrl: value.relayUrl,
      channelId: value.channelId,
      requestId: value.requestId,
      seed: {
        ownerName: value.seed.ownerName,
        ownerNote: value.seed.ownerNote,
        businessName: value.seed.businessName,
        businessDescription: value.seed.businessDescription,
        website: value.seed.website,
        websiteState: value.seed.websiteState,
      },
    };
  } catch {
    return null;
  }
}

export function scoutOnboardingRootStorageKey(
  scope: ScoutOnboardingRootScope,
): string {
  if (!isValidScope(scope)) {
    throw new Error("This signup root belongs to a different account.");
  }
  return `${SCOUT_ONBOARDING_ROOT_STORAGE_PREFIX}${JSON.stringify([
    scope.ownerPubkey,
    scope.relayUrl,
    scope.channelId,
    scope.requestId,
  ])}`;
}

/** Stable, owner-readable text; no job, task, social post, or worker instruction is included. */
export function scoutOnboardingRootBody(
  payload: ScoutOnboardingRootPayload,
): string {
  const seed = payload.seed;
  const website =
    seed.websiteState === "provided"
      ? `Website: ${seed.website}`
      : seed.websiteState === "none"
        ? "Website: None provided"
        : "Website: Not provided yet";
  return [
    "**Scout onboarding context**",
    seed.ownerName ? `Owner: ${seed.ownerName}` : "",
    seed.ownerNote ? `Owner note: ${seed.ownerNote}` : "",
    seed.businessName ? `Business: ${seed.businessName}` : "",
    seed.businessDescription ? `Description: ${seed.businessDescription}` : "",
    website,
    "Scout will ask a few structured questions here. You will review and confirm the understanding before any business setup begins.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The compact surface shared by the initial handoff, delivery, and setup agents. */
export const ROOT_PROTOCOL = {
  marker: SCOUT_ONBOARDING_ROOT_MARKER,
  kind: SCOUT_ONBOARDING_ROOT_KIND,
  legacySuppressionMarker: SCOUT_ONBOARDING_LEGACY_SUPPRESSION_MARKER,
  createPayload: createScoutOnboardingRootPayload,
  seedFromDraft: scoutOnboardingRootSeedFromDraft,
  body: scoutOnboardingRootBody,
  tag: scoutOnboardingRootTag,
  tags: scoutOnboardingRootTags,
  parse: parseScoutOnboardingRoot,
  storageKey: scoutOnboardingRootStorageKey,
  isValid: isValidScoutOnboardingRootPayload,
} as const;

export type ScoutOnboardingRootProtocol = typeof ROOT_PROTOCOL;
