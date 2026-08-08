import { verifyEvent } from "nostr-tools/pure";

import type { RelayEvent } from "@/shared/api/types";
import { KIND_PARTY, KIND_PARTY_RELATIONSHIP } from "@/shared/constants/kinds";

import {
  canonicalCompanyJson as canonicalRecordJson,
  normalizeHex,
} from "@/features/company/contracts";

/**
 * The desktop mirror of `buzz_core::party`.
 *
 * A Party is one real-world business or person. Lead and Client are views over
 * that identity rather than separate records, which is what lets a lead that
 * converts keep its history instead of being retyped as a client.
 *
 * Like the company contracts, this file is a boundary rather than a
 * convenience: Rust refuses unknown fields, unknown enum values, and
 * non-canonical content on every one of these records, and so does this. The
 * canonical-JSON encoder is imported from the company contracts rather than
 * copied, because a second implementation of it would drift and the drift would
 * only surface on real input.
 */

export const PARTY_SCHEMA = "colony.party/v1";
export const PARTY_ALIAS_SCHEMA = "colony.party-alias/v1";
export const PARTY_RELATIONSHIP_SCHEMA = "colony.party-relationship/v1";

export const PARTY_KINDS = ["organization", "person"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const IDENTIFIER_SCHEMES = [
  "domain",
  "email",
  "phone",
  "linkedin",
  "registrationNumber",
] as const;
export type IdentifierScheme = (typeof IDENTIFIER_SCHEMES)[number];

export const IDENTIFIER_CONFIDENCES = ["asserted", "verified"] as const;
export type IdentifierConfidence = (typeof IDENTIFIER_CONFIDENCES)[number];

export const RELATIONSHIP_KINDS = ["lead", "client"] as const;
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

export const RELATIONSHIP_STATUSES = [
  "candidate",
  "accepted",
  "qualified",
  "disqualified",
  "dormant",
  "active",
  "paused",
  "former",
] as const;
export type RelationshipStatus = (typeof RELATIONSHIP_STATUSES)[number];

/** Which statuses belong to which view. Mirrors `RelationshipStatus::belongs_to`. */
const STATUSES_BY_VIEW: Record<RelationshipKind, readonly string[]> = {
  lead: ["candidate", "accepted", "qualified", "disqualified", "dormant"],
  client: ["active", "paused", "former"],
};

/**
 * Which statuses a Lead relationship can move to directly.
 *
 * Mirrors `is_relationship_transition_allowed` for `RelationshipKind::Lead`
 * (same-status included; `disqualified` is terminal). Presentation only: the
 * relay decides legality and stays the authority. Client-only statuses map to
 * themselves so the record stays total, which is exactly the settled truth:
 * a Lead can never move into `active`.
 */
export const LEAD_STATUS_TRANSITIONS: Record<
  RelationshipStatus,
  readonly RelationshipStatus[]
> = {
  candidate: ["candidate", "accepted", "disqualified"],
  accepted: ["accepted", "qualified", "dormant", "disqualified"],
  qualified: ["qualified", "dormant", "disqualified"],
  dormant: ["dormant", "qualified", "disqualified"],
  disqualified: ["disqualified"],
  active: ["active"],
  paused: ["paused"],
  former: ["former"],
};

export type PartyIdentifier = {
  scheme: IdentifierScheme;
  value: string;
  confidence: IdentifierConfidence;
};

export type ProvenanceEntry = {
  id: string;
  source: string;
  observedAt: number;
  sourceRef: string | null;
  fields: string[];
};

export type Party = {
  schema: string;
  id: string;
  companyId: string;
  kind: PartyKind;
  displayName: string;
  legalName: string | null;
  identifiers: PartyIdentifier[];
  provenance: ProvenanceEntry[];
  retiredHandles: string[];
  createdAt: number;
  updatedAt: number;
};

/** The pointer a merge leaves at a retired handle. */
export type PartyAlias = {
  schema: string;
  id: string;
  companyId: string;
  resolvesTo: string;
  mergedAt: number;
  mergeActionEventId: string;
};

export type PartyRelationship = {
  schema: string;
  id: string;
  companyId: string;
  partyId: string;
  relationship: RelationshipKind;
  status: RelationshipStatus;
  ownerPersonaId: string;
  sourceChannelId: string;
  createdAt: number;
  updatedAt: number;
};

/** A `KIND_PARTY` head is either a live party or a retired handle. */
export type PartyHead =
  | { type: "party"; party: Party }
  | { type: "alias"; alias: PartyAlias };

export type PartyFailureCode =
  | "invalid-event"
  | "wrong-author"
  | "invalid-record"
  | "invalid-head"
  | "missing-head"
  | "no-relay-identity"
  | "unavailable"
  | "cancelled";

export type PartyParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PartyFailureCode; message: string };

export function partyFailure<T>(
  code: PartyFailureCode,
  message: string,
): PartyParseResult<T> {
  return { ok: false, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

type FieldKind =
  | { type: "string" }
  | { type: "optionalString" }
  | { type: "integer" }
  | { type: "stringArray" }
  | { type: "enum"; values: readonly string[] }
  | { type: "objectArray"; fields: Record<string, FieldKind> };

function checkField(value: unknown, kind: FieldKind): boolean {
  switch (kind.type) {
    case "string":
      return typeof value === "string" && value.trim() !== "";
    case "optionalString":
      return value === null || typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "stringArray":
      return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
      );
    case "enum":
      return typeof value === "string" && kind.values.includes(value);
    case "objectArray":
      return (
        Array.isArray(value) &&
        value.every((item) => matchesShape(item, kind.fields))
      );
  }
}

/** Exactly the declared keys, no more and no fewer, each of the declared kind. */
function matchesShape(
  value: unknown,
  fields: Record<string, FieldKind>,
): boolean {
  if (!isPlainObject(value)) return false;
  const declared = Object.keys(fields);
  const present = Object.keys(value);
  if (present.length !== declared.length) return false;
  return declared.every(
    (key) => key in value && checkField(value[key], fields[key] as FieldKind),
  );
}

const IDENTIFIER_FIELDS: Record<string, FieldKind> = {
  scheme: { type: "enum", values: IDENTIFIER_SCHEMES },
  value: { type: "string" },
  confidence: { type: "enum", values: IDENTIFIER_CONFIDENCES },
};

const PROVENANCE_FIELDS: Record<string, FieldKind> = {
  id: { type: "string" },
  source: { type: "string" },
  observedAt: { type: "integer" },
  sourceRef: { type: "optionalString" },
  fields: { type: "stringArray" },
};

const PARTY_FIELDS: Record<string, FieldKind> = {
  schema: { type: "string" },
  id: { type: "string" },
  companyId: { type: "string" },
  kind: { type: "enum", values: PARTY_KINDS },
  displayName: { type: "string" },
  legalName: { type: "optionalString" },
  identifiers: { type: "objectArray", fields: IDENTIFIER_FIELDS },
  provenance: { type: "objectArray", fields: PROVENANCE_FIELDS },
  retiredHandles: { type: "stringArray" },
  createdAt: { type: "integer" },
  updatedAt: { type: "integer" },
};

const ALIAS_FIELDS: Record<string, FieldKind> = {
  schema: { type: "string" },
  id: { type: "string" },
  companyId: { type: "string" },
  resolvesTo: { type: "string" },
  mergedAt: { type: "integer" },
  mergeActionEventId: { type: "string" },
};

const RELATIONSHIP_FIELDS: Record<string, FieldKind> = {
  schema: { type: "string" },
  id: { type: "string" },
  companyId: { type: "string" },
  partyId: { type: "string" },
  relationship: { type: "enum", values: RELATIONSHIP_KINDS },
  status: { type: "enum", values: RELATIONSHIP_STATUSES },
  ownerPersonaId: { type: "string" },
  sourceChannelId: { type: "string" },
  createdAt: { type: "integer" },
  updatedAt: { type: "integer" },
};

function validSignedEvent(event: RelayEvent): boolean {
  try {
    // nostr-tools memoizes verification onto the event object. Cloning keeps a
    // caller-supplied memoization symbol from surviving into this boundary.
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    });
  } catch {
    return false;
  }
}

function scalarTags(event: RelayEvent, name: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === name && tag.length === 2)
    .map((tag) => tag[1] as string);
}

function exactlyOneTag(event: RelayEvent, name: string): string | null {
  const values = scalarTags(event, name);
  const all = event.tags.filter((tag) => tag[0] === name);
  return values.length === 1 && all.length === 1 ? (values[0] as string) : null;
}

/**
 * The coordinate a relationship lives at.
 *
 * Derived, never chosen. That derivation is what makes a second Lead on one
 * party structurally impossible: there is nowhere else to put it.
 */
export function relationshipCoordinate(
  partyId: string,
  kind: RelationshipKind,
): string {
  return `${partyId}:${kind}`;
}

/** Shared preamble: right kind, authored by this relay, genuinely signed. */
function readHead(
  event: RelayEvent,
  relaySelfPubkey: string,
  kind: number,
): PartyParseResult<Record<string, unknown>> {
  if (event.kind !== kind) {
    return partyFailure("invalid-event", "wrong event kind for this record");
  }
  const relay = normalizeHex(relaySelfPubkey);
  if (relay === "" || normalizeHex(event.pubkey) !== relay) {
    return partyFailure(
      "wrong-author",
      "party records are only valid when authored by this community's relay",
    );
  }
  if (!validSignedEvent(event)) {
    return partyFailure("invalid-event", "party head signature is invalid");
  }
  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return partyFailure("invalid-record", "party content is not JSON");
  }
  if (!isPlainObject(content)) {
    return partyFailure("invalid-record", "party content is not an object");
  }
  if (canonicalRecordJson(content) !== event.content) {
    return partyFailure(
      "invalid-record",
      "party content must use canonical JSON",
    );
  }
  return { ok: true, value: content };
}

/**
 * Parse a `KIND_PARTY` head, which is a live party or a retired handle.
 *
 * The two share a coordinate space on purpose: a handle is either a party or a
 * pointer to one, never both, and a reader that could not tell them apart would
 * write new evidence to a coordinate that only redirects.
 */
export function parsePartyHead(
  event: RelayEvent,
  relaySelfPubkey: string,
): PartyParseResult<PartyHead> {
  const head = readHead(event, relaySelfPubkey, KIND_PARTY);
  if (!head.ok) return head;
  const record = head.value;
  const schema = record.schema;

  if (schema === PARTY_ALIAS_SCHEMA) {
    if (!matchesShape(record, ALIAS_FIELDS)) {
      return partyFailure("invalid-record", "alias record shape is invalid");
    }
    const alias = record as unknown as PartyAlias;
    if (alias.id === alias.resolvesTo) {
      return partyFailure("invalid-record", "an alias cannot point at itself");
    }
    if (
      exactlyOneTag(event, "d") !== alias.id ||
      exactlyOneTag(event, "c") !== alias.companyId ||
      exactlyOneTag(event, "alias") !== alias.resolvesTo
    ) {
      return partyFailure(
        "invalid-head",
        "alias head tags do not match its content",
      );
    }
    return { ok: true, value: { type: "alias", alias } };
  }

  if (schema !== PARTY_SCHEMA) {
    return partyFailure("invalid-record", "unsupported party schema");
  }
  if (!matchesShape(record, PARTY_FIELDS)) {
    return partyFailure("invalid-record", "party record shape is invalid");
  }
  const party = record as unknown as Party;
  // Tags are what queries match on. A head whose tags disagree with its content
  // is reachable under a coordinate describing a different party.
  if (
    exactlyOneTag(event, "d") !== party.id ||
    exactlyOneTag(event, "c") !== party.companyId ||
    exactlyOneTag(event, "party-kind") !== party.kind
  ) {
    return partyFailure(
      "invalid-head",
      "party head tags do not match its content",
    );
  }
  // One `identifier` tag per claim, so a Discovery run can find a party by
  // domain without scanning. A tag set that disagrees with the claims would let
  // a party be found under an identifier it does not hold.
  const tagged = scalarTags(event, "identifier").sort();
  const claimed = party.identifiers
    .map((identifier) => `${identifier.scheme}:${identifier.value}`)
    .sort();
  if (
    tagged.length !== claimed.length ||
    tagged.some((value, index) => value !== claimed[index])
  ) {
    return partyFailure(
      "invalid-head",
      "party head identifier tags do not match its claims",
    );
  }
  return { ok: true, value: { type: "party", party } };
}

export function parsePartyRelationshipHead(
  event: RelayEvent,
  relaySelfPubkey: string,
): PartyParseResult<PartyRelationship> {
  const head = readHead(event, relaySelfPubkey, KIND_PARTY_RELATIONSHIP);
  if (!head.ok) return head;
  const record = head.value;
  if (!matchesShape(record, RELATIONSHIP_FIELDS)) {
    return partyFailure(
      "invalid-record",
      "relationship record shape is invalid",
    );
  }
  const relationship = record as unknown as PartyRelationship;
  if (relationship.schema !== PARTY_RELATIONSHIP_SCHEMA) {
    return partyFailure("invalid-record", "unsupported relationship schema");
  }
  // A Client status on a Lead view describes a state that view cannot be in.
  if (
    !STATUSES_BY_VIEW[relationship.relationship].includes(relationship.status)
  ) {
    return partyFailure(
      "invalid-record",
      "that status does not belong to this relationship",
    );
  }
  if (
    relationship.id !==
    relationshipCoordinate(relationship.partyId, relationship.relationship)
  ) {
    return partyFailure(
      "invalid-record",
      "relationship id is not derived from its coordinate",
    );
  }
  if (
    exactlyOneTag(event, "d") !== relationship.id ||
    exactlyOneTag(event, "c") !== relationship.companyId ||
    exactlyOneTag(event, "party") !== relationship.partyId
  ) {
    return partyFailure(
      "invalid-head",
      "relationship head tags do not match its content",
    );
  }
  return { ok: true, value: relationship };
}
