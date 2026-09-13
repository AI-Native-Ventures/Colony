import { verifyEvent } from "nostr-tools/pure";

import type { RelayEvent } from "@/shared/api/types";
import type { CompanyProfile } from "@/features/company/contracts";
import type {
  ExistingWebsiteState,
  ScoutOnboardingSummary,
  ScoutSetupInput,
  ScoutSetupProof,
} from "./channelOnboarding/types";
import type { ChannelOnboardingScope } from "./channelOnboardingStorage";
import {
  SCOUT_ONBOARDING_ROOT_KIND,
  parseScoutOnboardingRoot,
  scoutOnboardingRootBody,
  scoutOnboardingRootTags,
} from "./channelOnboardingRuntime/protocol";

export type { ChannelOnboardingScope } from "./channelOnboardingStorage";

export const SCOUT_ONBOARDING_SETUP_VERSION = 1 as const;
export const SCOUT_ONBOARDING_ACK_MARKER =
  "colony:scout-onboarding-approval:v1" as const;

const HEX_64 = /^[a-f0-9]{64}$/i;
const HEX_128 = /^[a-f0-9]{128}$/i;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function canonical(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Setup values must be finite.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  throw new Error("Setup values must be JSON values.");
}

function stringValue(value: unknown): value is string {
  return typeof value === "string";
}

function summaryValue(
  value: unknown,
  route: ScoutSetupInput["route"],
): value is ScoutOnboardingSummary {
  if (!isRecord(value)) return false;
  if (
    value.route !== route ||
    !stringValue(value.person) ||
    !stringValue(value.businessOrIdea) ||
    !stringValue(value.priority) ||
    !stringValue(value.priorityId) ||
    !Array.isArray(value.unknowns) ||
    !value.unknowns.every(stringValue) ||
    !(value.website === null || stringValue(value.website)) ||
    !(value.location === null || stringValue(value.location))
  ) {
    return false;
  }
  if (
    value.websiteState !== "unknown" &&
    value.websiteState !== "provided" &&
    value.websiteState !== "none"
  ) {
    return false;
  }
  if (route === "new") {
    if (
      !(value.category === undefined || stringValue(value.category)) ||
      !(value.ideaStage === undefined || stringValue(value.ideaStage))
    ) {
      return false;
    }
  }
  if (route === "deciding") {
    if (
      !Array.isArray(value.skills) ||
      !value.skills.every(stringValue) ||
      !stringValue(value.direction)
    ) {
      return false;
    }
  }
  return true;
}

/** Validate and freeze the exact owner-reviewed setup values. */
export function snapshotScoutSetupInput(
  input: ScoutSetupInput,
): ScoutSetupInput {
  if (
    !isRecord(input) ||
    (input.route !== "new" &&
      input.route !== "existing" &&
      input.route !== "deciding") ||
    !summaryValue(input.summary, input.route) ||
    !stringValue(input.setupName) ||
    !stringValue(input.setupDescription)
  ) {
    throw new Error(
      "This Scout setup is incomplete. Review the understanding before approving it.",
    );
  }
  return deepFreeze(clone(input));
}

/** Byte-stable comparison used by durable retry and root authorization. */
export function sameScoutSetupInput(
  left: ScoutSetupInput,
  right: ScoutSetupInput,
) {
  return canonical(left) === canonical(right);
}

function websiteStateFromInput(input: ScoutSetupInput): ExistingWebsiteState {
  const candidate = input as ScoutSetupInput & {
    websiteState?: unknown;
  };
  const summary = input.summary as ScoutOnboardingSummary & {
    websiteState?: unknown;
  };
  if (
    candidate.websiteState === "provided" ||
    candidate.websiteState === "none" ||
    candidate.websiteState === "unknown"
  ) {
    return candidate.websiteState;
  }
  if (
    summary.websiteState === "provided" ||
    summary.websiteState === "none" ||
    summary.websiteState === "unknown"
  ) {
    return summary.websiteState;
  }
  return input.summary.website === null ? "unknown" : "provided";
}

function validWebsite(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Apply only the values explicitly approved in the setup snapshot.
 *
 * Existing company fields are copied intact. A blank setup name keeps the
 * current canonical name rather than inventing one from a category or idea;
 * an explicit blank description remains an explicit blank description. An
 * unknown website remains unknown and therefore does not clear an existing
 * website. The caller persists the route's website state alongside the
 * signed snapshot, so `none` and `unknown` remain distinguishable on reload.
 */
export function buildScoutCompanyProfile(
  current: CompanyProfile,
  input: ScoutSetupInput,
  nowSeconds: number,
): { profile: CompanyProfile; websiteState: ExistingWebsiteState } {
  const reviewed = snapshotScoutSetupInput(input);
  const profile = clone(current);
  const name = reviewed.setupName.trim();
  if (name) profile.tradingName = name;

  profile.summary = reviewed.setupDescription;
  const websiteState = websiteStateFromInput(reviewed);
  if (websiteState === "provided") {
    const website = reviewed.summary.website?.trim() ?? "";
    if (!website || !validWebsite(website)) {
      throw new Error("The approved website is not a valid http(s) address.");
    }
    profile.website = website;
  } else if (websiteState === "none") {
    profile.website = null;
  }

  if (!Number.isFinite(nowSeconds) || !Number.isSafeInteger(nowSeconds)) {
    throw new Error("The setup clock could not be verified.");
  }
  profile.updatedAt = Math.max(profile.updatedAt + 1, nowSeconds);
  return { profile: deepFreeze(profile), websiteState };
}

export type ScoutSetupAcknowledgementTagPayload = {
  version: typeof SCOUT_ONBOARDING_SETUP_VERSION;
  requestId: string;
  input: ScoutSetupInput;
};

/** The exact snapshot belongs in a client tag, never in normal message text. */
export function scoutSetupAcknowledgementTag(
  input: ScoutSetupInput,
  approvalRequestId: string,
): string[] {
  const snapshot = snapshotScoutSetupInput(input);
  if (approvalRequestId.trim() === "") {
    throw new Error("The Scout acknowledgment request is missing its id.");
  }
  const payload: ScoutSetupAcknowledgementTagPayload = {
    version: SCOUT_ONBOARDING_SETUP_VERSION,
    requestId: approvalRequestId,
    input: snapshot,
  };
  const encoded = JSON.stringify(payload);
  if (encoded.length > 32_000) {
    throw new Error("The approved Scout setup is too large to send.");
  }
  return ["client", SCOUT_ONBOARDING_ACK_MARKER, encoded];
}

/** Parse only the versioned, tag-carried approval snapshot. */
export function parseScoutSetupAcknowledgementTag(
  tags: readonly string[][] | null | undefined,
): ScoutSetupAcknowledgementTagPayload | null {
  const matches = tags?.filter(
    (tag) => tag[0] === "client" && tag[1] === SCOUT_ONBOARDING_ACK_MARKER,
  );
  if (matches?.length !== 1) return null;
  const tag = matches[0];
  if (tag?.length !== 3 || !tag[2]) return null;
  try {
    const parsed: unknown = JSON.parse(tag[2]);
    if (
      !isRecord(parsed) ||
      parsed.version !== SCOUT_ONBOARDING_SETUP_VERSION ||
      typeof parsed.requestId !== "string" ||
      !isRecord(parsed.input)
    ) {
      return null;
    }
    const input = snapshotScoutSetupInput(parsed.input as ScoutSetupInput);
    return {
      version: SCOUT_ONBOARDING_SETUP_VERSION,
      requestId: parsed.requestId,
      input,
    };
  } catch {
    return null;
  }
}

/** Human-readable request text; the signed snapshot remains in its client tag. */
export function scoutSetupAcknowledgementBody(input: ScoutSetupInput): string {
  const name = input.setupName.trim() || "this context";
  const description = input.setupDescription.trim();
  return [
    `I approve Scout's setup for ${name}.`,
    description
      ? `Scout should keep this context close: ${description}`
      : "Scout should keep the approved context close.",
    "Please acknowledge this setup in the Welcome thread; no job or extra teammate is being created.",
  ].join("\n\n");
}

function signedEvent(value: unknown): value is RelayEvent {
  return (
    isRecord(value) &&
    stringValue(value.id) &&
    HEX_64.test(value.id) &&
    stringValue(value.pubkey) &&
    HEX_64.test(value.pubkey) &&
    Number.isSafeInteger(value.created_at) &&
    Number.isSafeInteger(value.kind) &&
    Array.isArray(value.tags) &&
    value.tags.every(
      (tag) => Array.isArray(tag) && tag.every((item) => stringValue(item)),
    ) &&
    stringValue(value.content) &&
    stringValue(value.sig) &&
    HEX_128.test(value.sig)
  );
}

/** Parse the exact signed JSON returned by the native signing command. */
export function parseSignedScoutEvent(value: string | RelayEvent): RelayEvent {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("The signed Scout request was not readable.");
    }
  }
  if (!signedEvent(parsed)) {
    throw new Error("The signed Scout request was not a complete event.");
  }
  const event = clone(parsed);
  let valid = false;
  try {
    valid = verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    valid = false;
  }
  if (!valid) throw new Error("The signed Scout request failed verification.");
  return deepFreeze(event);
}

function tagValues(event: RelayEvent, name: string) {
  return event.tags.filter((tag) => tag[0] === name);
}

function exactHTag(event: RelayEvent, channelId: string) {
  const tags = tagValues(event, "h");
  return tags.length === 1 && tags[0]?.length === 2 && tags[0][1] === channelId;
}

/**
 * Check that the original root is still the owner-signed, channel-scoped
 * approval that authorized this exact setup input.
 */
export function assertScoutOnboardingRoot(
  scope: ChannelOnboardingScope,
  root: RelayEvent | null,
  _input: ScoutSetupInput,
) {
  assertScoutSignedRootEnvelope(scope, root);
  if (!root) return;
  // The root protocol deliberately carries signup context only. The later
  // owner acknowledgment carries the exact route/setup snapshot, so a root
  // must be checked against its protocol scope here rather than treated as if
  // it already contained the answer to the interview.
  const protocolPayload = parseScoutOnboardingRoot(root.tags);
  if (protocolPayload) {
    if (
      protocolPayload.ownerPubkey.toLowerCase() !==
        scope.ownerPubkey.toLowerCase() ||
      protocolPayload.relayUrl !== scope.relayUrl ||
      protocolPayload.channelId !== scope.channelId ||
      protocolPayload.requestId !== scope.requestId ||
      root.content !== scoutOnboardingRootBody(protocolPayload) ||
      JSON.stringify(root.tags) !==
        JSON.stringify(scoutOnboardingRootTags(protocolPayload))
    ) {
      throw new Error(
        "The Scout approval belongs to a different account or Welcome thread.",
      );
    }
    return;
  }
  throw new Error("This event is not a Scout onboarding root.");
}

/** Structural/event-signature check shared by protocol-specific validators. */
export function assertScoutSignedRootEnvelope(
  scope: ChannelOnboardingScope,
  root: RelayEvent | null,
) {
  if (!root || root.id !== scope.threadRootId) {
    throw new Error(
      "The original Scout approval could not be found. Reopen its Welcome thread.",
    );
  }
  if (root.kind !== SCOUT_ONBOARDING_ROOT_KIND) {
    throw new Error("This event is not a Scout onboarding root.");
  }
  if (
    root.pubkey.toLowerCase() !== scope.ownerPubkey.toLowerCase() ||
    !exactHTag(root, scope.channelId) ||
    tagValues(root, "e").length > 0
  ) {
    throw new Error(
      "The Scout approval belongs to a different account or Welcome thread.",
    );
  }
  // `parseSignedScoutEvent` verifies the signature without trusting the
  // renderer's display author or any relay-provided owner label.
  parseSignedScoutEvent(root);
}

/** Verify that a signed profile action is the frozen profile/CAS we intended. */
export function assertScoutProfileAction(
  action: RelayEvent,
  scope: ChannelOnboardingScope,
  input: ScoutSetupInput,
  profile: CompanyProfile,
  expectedHeadEventId: string,
  approvalRequestId = scope.requestId,
  relayPubkey?: string,
) {
  if (action.pubkey.toLowerCase() !== scope.ownerPubkey.toLowerCase()) {
    throw new Error("The company update was signed by a different owner.");
  }
  parseSignedScoutEvent(action);
  if (
    action.kind !== 40013 ||
    action.tags.some((tag) => tag[0] === "h") ||
    JSON.stringify(action.tags.map((tag) => tag[0])) !==
      JSON.stringify(["p", "a", "company-action"])
  ) {
    throw new Error("The company update has an unexpected action envelope.");
  }
  const companyAction = action.tags.find((tag) => tag[0] === "company-action");
  const relayTag = action.tags.find((tag) => tag[0] === "p");
  const targetTag = action.tags.find((tag) => tag[0] === "a");
  if (
    relayTag?.length !== 2 ||
    !targetTag ||
    targetTag.length !== 2 ||
    (relayPubkey !== undefined && relayTag[1] !== relayPubkey) ||
    (relayPubkey !== undefined &&
      targetTag[1] !== `30179:${relayPubkey}:profile`)
  ) {
    throw new Error(
      "The company update targets a different community profile.",
    );
  }
  if (
    companyAction?.length !== 5 ||
    !UUID.test(companyAction[3] ?? "") ||
    companyAction[3]?.toLowerCase() !== approvalRequestId.toLowerCase()
  ) {
    throw new Error("The company update is tied to a different request.");
  }
  let content: unknown;
  try {
    content = JSON.parse(action.content);
  } catch {
    throw new Error("The company update content is not readable.");
  }
  if (!isRecord(content))
    throw new Error("The company update content is invalid.");
  if (
    content.schema !== "colony.company-action/v1" ||
    content.operation !== "update" ||
    content.expectedHead !== expectedHeadEventId ||
    !Array.isArray(content.expectedReferences) ||
    content.expectedReferences.length !== 0 ||
    !isRecord(content.payload) ||
    content.payload.kind !== "company" ||
    canonical(content.payload.record) !== canonical(profile)
  ) {
    throw new Error(
      "The saved company update no longer matches the approved setup.",
    );
  }
  if (profile.summary !== input.setupDescription) {
    throw new Error(
      "The saved company update changed the approved description.",
    );
  }
  if (
    input.setupName.trim() &&
    profile.tradingName !== input.setupName.trim()
  ) {
    throw new Error("The saved company update changed the approved name.");
  }
}

/** Verify the owner-signed acknowledgment is in the same Welcome thread. */
export function assertScoutAcknowledgementEvent(
  value: string | RelayEvent,
  scope: ChannelOnboardingScope,
  input: ScoutSetupInput,
  acknowledgementEventId?: string,
  approvalRequestId = scope.requestId,
  scoutPubkey?: string,
): RelayEvent {
  const event = parseSignedScoutEvent(value);
  if (
    event.pubkey.toLowerCase() !== scope.ownerPubkey.toLowerCase() ||
    (event.kind !== 9 && event.kind !== 40002) ||
    !exactHTag(event, scope.channelId)
  ) {
    throw new Error("The Scout acknowledgment is outside the Welcome thread.");
  }
  const mentions = tagValues(event, "p");
  if (
    scoutPubkey !== undefined &&
    (mentions.length !== 1 ||
      mentions[0]?.length !== 2 ||
      mentions[0][1]?.toLowerCase() !== scoutPubkey.toLowerCase())
  ) {
    throw new Error("The Scout acknowledgment did not address Scout.");
  }
  const parent = event.tags.filter((tag) => tag[0] === "e");
  if (
    parent.length !== 1 ||
    parent[0]?.length < 2 ||
    parent[0][1] !== scope.threadRootId
  ) {
    throw new Error(
      "The Scout acknowledgment is not a reply to the approved root.",
    );
  }
  if (acknowledgementEventId && event.id !== acknowledgementEventId) {
    throw new Error("The saved Scout acknowledgment event changed.");
  }
  const marker = event.tags.find(
    (tag) => tag[0] === "client" && tag[1] === SCOUT_ONBOARDING_ACK_MARKER,
  );
  if (marker?.length !== 3) {
    throw new Error("The Scout acknowledgment is not tied to this request.");
  }
  const approved = parseScoutSetupAcknowledgementTag(event.tags);
  if (
    !approved ||
    approved.requestId !== approvalRequestId ||
    !sameScoutSetupInput(approved.input, input)
  ) {
    throw new Error(
      "The Scout acknowledgment does not carry the approved setup.",
    );
  }
  return event;
}

/** Verify the signed Scout reply that closes one setup acknowledgment. */
export function assertScoutReplyEvent(
  value: string | RelayEvent,
  scope: ChannelOnboardingScope,
  scoutPubkey: string,
  acknowledgementEventId: string,
): RelayEvent {
  const event = parseSignedScoutEvent(value);
  if (
    event.pubkey.toLowerCase() !== scoutPubkey.toLowerCase() ||
    (event.kind !== 9 && event.kind !== 40002) ||
    !exactHTag(event, scope.channelId) ||
    event.content.trim() === ""
  ) {
    throw new Error("Scout's reply is not a signed message in Welcome.");
  }
  const references = tagValues(event, "e");
  if (
    !references.some(
      (tag) => tag.length >= 2 && tag[1] === acknowledgementEventId,
    )
  ) {
    throw new Error("Scout's reply is not correlated to this acknowledgment.");
  }
  const rootReferences = references.filter((tag) => tag[3] === "root");
  if (
    rootReferences.some(
      (tag) => tag.length < 2 || tag[1] !== scope.threadRootId,
    )
  ) {
    throw new Error("Scout's reply belongs to a different Welcome thread.");
  }
  return event;
}

function proofObject(
  value: unknown,
): value is ScoutSetupProof & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.proofId === "string" &&
    value.proofId.trim().length > 0 &&
    value.proofId.length <= 512
  );
}

/** A real reply proof must carry both agent identity and correlation evidence. */
export function assertScoutSetupProof(
  value: ScoutSetupProof,
  scope: ChannelOnboardingScope,
  scoutPubkey: string,
  acknowledgementEventId: string,
  approvalRequestId = scope.requestId,
): ScoutSetupProof {
  if (!proofObject(value)) {
    throw new Error("Scout has not returned a verifiable setup reply.");
  }
  const proof = value as ScoutSetupProof & Record<string, unknown>;
  if (
    typeof proof.agentPubkey !== "string" ||
    proof.agentPubkey.toLowerCase() !== scoutPubkey.toLowerCase()
  ) {
    throw new Error("The setup reply came from a different agent.");
  }
  const channelId =
    typeof proof.channelId === "string"
      ? proof.channelId
      : isRecord(proof.scope) && typeof proof.scope.channelId === "string"
        ? proof.scope.channelId
        : null;
  if (channelId !== scope.channelId) {
    throw new Error("The setup reply belongs to a different channel.");
  }
  const correlations = [
    proof.acknowledgementEventId,
    proof.ackEventId,
    proof.triggeringEventId,
    proof.requestId,
  ].filter((item): item is string => typeof item === "string");
  if (
    !correlations.includes(acknowledgementEventId) &&
    !correlations.includes(approvalRequestId)
  ) {
    throw new Error(
      "The setup reply is not correlated to this acknowledgment.",
    );
  }
  const signedReply = proof.signedReplyEvent ?? proof.replyEvent;
  if (typeof signedReply !== "string" && !isRecord(signedReply)) {
    throw new Error("The setup reply did not include its signed message.");
  }
  const reply = assertScoutReplyEvent(
    signedReply as string | RelayEvent,
    scope,
    scoutPubkey,
    acknowledgementEventId,
  );
  if (proof.replyEventId !== reply.id) {
    throw new Error("The setup reply proof names a different signed message.");
  }
  if (typeof proof.turnId !== "string" || proof.turnId.trim() === "") {
    throw new Error("The setup reply did not include its completed turn.");
  }
  const evidenceIds = [
    proof.replyEventId,
    proof.responseEventId,
    proof.turnId,
    ...(Array.isArray(proof.recordIds) ? proof.recordIds : []),
  ].filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
  if (evidenceIds.length === 0) {
    throw new Error(
      "The setup reply did not include signed response evidence.",
    );
  }
  return deepFreeze(clone(value));
}
