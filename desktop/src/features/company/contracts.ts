import { verifyEvent } from "nostr-tools/pure";

import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_COHORT,
  KIND_COMPANY_PROFILE,
  KIND_INITIATIVE,
  KIND_TASK,
} from "@/shared/constants/kinds";

/**
 * The desktop mirror of `buzz_core::company`.
 *
 * These records are authored by the tenant relay and carry commercial and
 * accounting authority, so this file is a boundary, not a convenience. Rust
 * refuses unknown fields, unknown statuses, and non-canonical content on every
 * one of them; so does this. A looser reader here would mean the two
 * implementations disagree about what a valid company record is, and the
 * disagreement would surface on real input rather than in a test.
 */

export const COMPANY_SCHEMA = "colony.company/v1";
export const INITIATIVE_SCHEMA = "colony.initiative/v1";
export const TASK_SCHEMA = "colony.task/v1";
export const COHORT_SCHEMA = "colony.cohort/v1";
export const COMPANY_RECEIPT_SCHEMA = "colony.company-receipt/v1";

export const COMMERCIAL_PURPOSES = [
  "clientDelivery",
  "sales",
  "marketing",
  "administration",
  "internalProduct",
  "uncertain",
] as const;
export type CommercialPurpose = (typeof COMMERCIAL_PURPOSES)[number];

export const INITIATIVE_STATUSES = [
  "proposed",
  "approved",
  "active",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

export const TASK_STATUSES = [
  "proposed",
  "ready",
  "inProgress",
  "inReview",
  "blocked",
  "snoozed",
  "completed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const DOER_KINDS = ["agent", "human"] as const;
export type DoerKind = (typeof DOER_KINDS)[number];

/**
 * Statuses a task never leaves. Every other status is live work, which is why
 * the thread surface sorts those above these as "earlier tasks".
 */
export const TERMINAL_TASK_STATUSES = ["completed", "cancelled"] as const;
export type TerminalTaskStatus = (typeof TERMINAL_TASK_STATUSES)[number];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export const SUBJECT_KINDS = [
  "party",
  "task",
  "initiative",
  "external",
] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const COST_CLASSIFICATIONS = ["cogs", "opex", "needsReview"] as const;
export type CostClassification = (typeof COST_CLASSIFICATIONS)[number];

/**
 * The `d` tag every community profile head lives at. A constant, not an
 * identifier: there is one profile per community, and the relay host the head
 * came from already names which community that is.
 */
export const COMMUNITY_PROFILE_ID = "profile";

const COST_CENTRE_KINDS = ["service", "internal"] as const;
export type CostCentreKind = (typeof COST_CENTRE_KINDS)[number];

export type CompanyService = {
  id: string;
  name: string;
  description: string;
};

export type CostCentre = {
  id: string;
  name: string;
  kind: CostCentreKind;
  serviceId: string | null;
};

export type CompanyProfile = {
  schema: string;
  tradingName: string;
  legalName: string | null;
  website: string | null;
  summary: string;
  businessType: string;
  services: CompanyService[];
  customerSegments: string[];
  costCentres: CostCentre[];
  sourceReportEventId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type Initiative = {
  schema: string;
  id: string;
  title: string;
  summary: string;
  status: InitiativeStatus;
  ownerPersonaId: string;
  costCentreId: string;
  commercialPurpose: CommercialPurpose;
  clientOrganizationId: string | null;
  expectedCostUsd: number | null;
  sourceChannelId: string;
  sourceEventId: string | null;
  createdAt: number;
  updatedAt: number;
};

/** What a task's work is about. The JSON key is literally `ref`: the Rust
 * field is the raw identifier `r#ref` and serde strips the prefix. */
export type SubjectRef = {
  kind: SubjectKind;
  ref: string;
};

/**
 * Why a task's delivered output was bounced back for rework.
 *
 * Serialized by `BounceReason` in buzz-core as an externally tagged enum with
 * `tag = "kind"`, `content = "value"`, so both variants are `{kind, value}`.
 */
export const BOUNCE_REASON_KINDS = ["criterion", "freeText"] as const;
export type BounceReasonKind = (typeof BOUNCE_REASON_KINDS)[number];

export type BounceReason = {
  kind: BounceReasonKind;
  value: string;
};

export type CompanyTask = {
  schema: string;
  id: string;
  initiativeId: string | null;
  title: string;
  status: TaskStatus;
  owningTeamId: string;
  assigneePersonaIds: string[];
  qaPersonaId: string;
  /** Team that reviews this task, when the owning team does not review itself. */
  reviewerTeamId: string | null;
  costCentreId: string;
  commercialPurpose: CommercialPurpose;
  clientOrganizationId: string | null;
  sourceChannelId: string;
  sourceEventId: string | null;
  implicit: boolean;
  dependsOn: string[];
  subject: SubjectRef | null;
  stage: string | null;
  threadRoot: string | null;
  doerKind: DoerKind;
  wakeAt: number | null;
  /** Why this task's outcome ended the way it did. Free text for now. */
  outcomeReason: string | null;
  /** Reason for the most recent bounce. Only the latest one. */
  bounceReason: BounceReason | null;
  /** How many times delivered output has been bounced back. */
  bounceCount: number;
  createdAt: number;
  updatedAt: number;
};

/** Inert data, no lifecycle: mirror of buzz-core's `Cohort`. */
export type Cohort = {
  schema: string;
  id: string;
  name: string;
  members: SubjectRef[];
  createdAt: number;
  updatedAt: number;
};

export type CompanyFailureCode =
  | "invalid-event"
  | "wrong-author"
  | "invalid-head"
  | "invalid-record"
  | "missing-head"
  | "no-relay-identity"
  | "unavailable"
  | "cancelled";

export type CompanyParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: CompanyFailureCode; message: string };

export function companyFailure<T>(
  code: CompanyFailureCode,
  message: string,
): CompanyParseResult<T> {
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

/**
 * Byte-for-byte the encoding `buzz_core::block::canonical_json` produces, which
 * is what the relay signs company content as. Comparing a re-encode against the
 * stored content is how a record that parses but was not written by that
 * encoder is caught.
 */
export function canonicalCompanyJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Company records cannot contain non-finite numbers.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalCompanyJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalCompanyJson(value[key] as unknown)}`,
      )
      .join(",")}}`;
  }
  throw new Error("Company records must contain JSON values only.");
}

export function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

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

type FieldKind =
  | { type: "string" }
  | { type: "optionalString" }
  | { type: "integer" }
  | { type: "boolean" }
  | { type: "optionalNumber" }
  | { type: "optionalInteger" }
  | { type: "stringArray" }
  | { type: "enum"; values: readonly string[] }
  | { type: "objectArray"; fields: Record<string, FieldKind> }
  | { type: "objectOrNull"; fields: Record<string, FieldKind> };

function checkField(value: unknown, kind: FieldKind): boolean {
  switch (kind.type) {
    case "string":
      return typeof value === "string" && value.trim() !== "";
    case "optionalString":
      return value === null || typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "optionalNumber":
      return (
        value === null || (typeof value === "number" && Number.isFinite(value))
      );
    // i64 fields: whole numbers only, unlike the f64 optionalNumber.
    case "optionalInteger":
      return (
        value === null ||
        (typeof value === "number" && Number.isSafeInteger(value))
      );
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
    // Option<struct> on the Rust side: null is None, an object must be
    // exactly its declared shape.
    case "objectOrNull":
      return (
        value === null ||
        (isPlainObject(value) && matchesShape(value, kind.fields))
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

const SERVICE_FIELDS: Record<string, FieldKind> = {
  id: { type: "string" },
  name: { type: "string" },
  description: { type: "optionalString" },
};

const COST_CENTRE_FIELDS: Record<string, FieldKind> = {
  id: { type: "string" },
  name: { type: "string" },
  kind: { type: "enum", values: COST_CENTRE_KINDS },
  serviceId: { type: "optionalString" },
};

const COMPANY_FIELDS: Record<string, FieldKind> = {
  schema: { type: "string" },
  tradingName: { type: "string" },
  legalName: { type: "optionalString" },
  website: { type: "optionalString" },
  summary: { type: "optionalString" },
  businessType: { type: "string" },
  services: { type: "objectArray", fields: SERVICE_FIELDS },
  customerSegments: { type: "stringArray" },
  costCentres: { type: "objectArray", fields: COST_CENTRE_FIELDS },
  sourceReportEventId: { type: "optionalString" },
  createdAt: { type: "integer" },
  updatedAt: { type: "integer" },
};

const INITIATIVE_FIELDS: Record<string, FieldKind> = {
  schema: { type: "string" },
  id: { type: "string" },
  title: { type: "string" },
  summary: { type: "optionalString" },
  status: { type: "enum", values: INITIATIVE_STATUSES },
  ownerPersonaId: { type: "string" },
  costCentreId: { type: "string" },
  commercialPurpose: { type: "enum", values: COMMERCIAL_PURPOSES },
  clientOrganizationId: { type: "optionalString" },
  expectedCostUsd: { type: "optionalNumber" },
  sourceChannelId: { type: "string" },
  sourceEventId: { type: "optionalString" },
  createdAt: { type: "integer" },
  updatedAt: { type: "integer" },
};

const SUBJECT_REF_FIELDS: Record<string, FieldKind> = {
  kind: { type: "enum", values: SUBJECT_KINDS },
  ref: { type: "string" },
};

const COHORT_FIELDS: Record<string, FieldKind> = {
  schema: { type: "string" },
  id: { type: "string" },
  name: { type: "string" },
  members: { type: "objectArray", fields: SUBJECT_REF_FIELDS },
  createdAt: { type: "integer" },
  updatedAt: { type: "integer" },
};

const BOUNCE_REASON_FIELDS: Record<string, FieldKind> = {
  kind: { type: "enum", values: BOUNCE_REASON_KINDS },
  value: { type: "string" },
};

const TASK_FIELDS: Record<string, FieldKind> = {
  schema: { type: "string" },
  id: { type: "string" },
  initiativeId: { type: "optionalString" },
  title: { type: "string" },
  status: { type: "enum", values: TASK_STATUSES },
  owningTeamId: { type: "string" },
  assigneePersonaIds: { type: "stringArray" },
  qaPersonaId: { type: "string" },
  reviewerTeamId: { type: "optionalString" },
  costCentreId: { type: "string" },
  commercialPurpose: { type: "enum", values: COMMERCIAL_PURPOSES },
  clientOrganizationId: { type: "optionalString" },
  sourceChannelId: { type: "string" },
  sourceEventId: { type: "optionalString" },
  implicit: { type: "boolean" },
  dependsOn: { type: "stringArray" },
  subject: { type: "objectOrNull", fields: SUBJECT_REF_FIELDS },
  stage: { type: "optionalString" },
  threadRoot: { type: "optionalString" },
  doerKind: { type: "enum", values: DOER_KINDS },
  wakeAt: { type: "optionalInteger" },
  outcomeReason: { type: "optionalString" },
  bounceReason: { type: "objectOrNull", fields: BOUNCE_REASON_FIELDS },
  bounceCount: { type: "integer" },
  createdAt: { type: "integer" },
  updatedAt: { type: "integer" },
};

/**
 * What serde fills in when a task head's content lacks the chain-and-identity
 * fields: `#[serde(default)]` on dependsOn and doerKind, `None` for the
 * options. Heads written before those fields existed are still served by the
 * relay verbatim and still deserialize in Rust, so desktop injects these same
 * values before the exact-shape check instead of refusing every older head.
 */
const TASK_FIELD_DEFAULTS: Record<string, unknown> = {
  dependsOn: [],
  subject: null,
  stage: null,
  threadRoot: null,
  doerKind: "agent",
  wakeAt: null,
  // The relay omits this one rather than writing it as null, because desktop
  // builds shipped before the field existed match on an EXACT field set and
  // would reject every head carrying it. So an absent key is the ordinary
  // case here, not only a legacy one.
  reviewerTeamId: null,
  // Written by every current relay, absent from heads predating the bounce
  // and outcome fields. They are defaulted rather than declared-only because
  // the shape check matches on an EXACT field set: an undeclared key the
  // relay does write rejects the head, and a declared key it does not write
  // rejects it just as hard.
  outcomeReason: null,
  bounceReason: null,
  bounceCount: 0,
};

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

/** Shared preamble: right kind, authored by this relay, genuinely signed. */
function readHead(
  event: RelayEvent,
  relaySelfPubkey: string,
  kind: number,
): CompanyParseResult<Record<string, unknown>> {
  if (event.kind !== kind) {
    return companyFailure("invalid-event", "wrong event kind for this record");
  }
  const relay = normalizeHex(relaySelfPubkey);
  if (relay === "" || normalizeHex(event.pubkey) !== relay) {
    return companyFailure(
      "wrong-author",
      "company records are only valid when authored by this community's relay",
    );
  }
  if (!validSignedEvent(event)) {
    return companyFailure("invalid-event", "company head signature is invalid");
  }
  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return companyFailure("invalid-record", "company content is not JSON");
  }
  if (!isPlainObject(content)) {
    return companyFailure("invalid-record", "company content is not an object");
  }
  if (canonicalCompanyJson(content) !== event.content) {
    return companyFailure(
      "invalid-record",
      "company content must use canonical JSON",
    );
  }
  return { ok: true, value: content };
}

export function parseCompanyHead(
  event: RelayEvent,
  relaySelfPubkey: string,
): CompanyParseResult<CompanyProfile> {
  const head = readHead(event, relaySelfPubkey, KIND_COMPANY_PROFILE);
  if (!head.ok) return head;
  const record = head.value;
  if (!matchesShape(record, COMPANY_FIELDS)) {
    return companyFailure("invalid-record", "company record shape is invalid");
  }
  const profile = record as unknown as CompanyProfile;
  if (profile.schema !== COMPANY_SCHEMA) {
    return companyFailure("invalid-record", "unsupported company schema");
  }
  // Tags are what queries match on. A head whose tags disagree with its content
  // is reachable under a coordinate that describes a different company.
  if (exactlyOneTag(event, "d") !== COMMUNITY_PROFILE_ID) {
    return companyFailure(
      "invalid-head",
      "company head tags do not match its content",
    );
  }
  return { ok: true, value: profile };
}

export function parseInitiativeHead(
  event: RelayEvent,
  relaySelfPubkey: string,
): CompanyParseResult<Initiative> {
  const head = readHead(event, relaySelfPubkey, KIND_INITIATIVE);
  if (!head.ok) return head;
  const record = head.value;
  if (!matchesShape(record, INITIATIVE_FIELDS)) {
    return companyFailure(
      "invalid-record",
      "initiative record shape is invalid",
    );
  }
  const initiative = record as unknown as Initiative;
  if (initiative.schema !== INITIATIVE_SCHEMA) {
    return companyFailure("invalid-record", "unsupported initiative schema");
  }
  if (
    exactlyOneTag(event, "d") !== initiative.id ||
    exactlyOneTag(event, "cost-centre") !== initiative.costCentreId
  ) {
    return companyFailure(
      "invalid-head",
      "initiative head tags do not match its content",
    );
  }
  return { ok: true, value: initiative };
}

export function parseTaskHead(
  event: RelayEvent,
  relaySelfPubkey: string,
): CompanyParseResult<CompanyTask> {
  const head = readHead(event, relaySelfPubkey, KIND_TASK);
  if (!head.ok) return head;
  // Older heads lack the defaulted keys entirely; the injection happens on a
  // copy so the signed content itself is never rewritten. A key that IS
  // present in the content always wins over its default, so a malformed
  // explicit value still fails the shape check exactly as Rust would.
  const record = { ...TASK_FIELD_DEFAULTS, ...head.value };
  if (!matchesShape(record, TASK_FIELDS)) {
    return companyFailure("invalid-record", "task record shape is invalid");
  }
  const task = record as unknown as CompanyTask;
  if (task.schema !== TASK_SCHEMA) {
    return companyFailure("invalid-record", "unsupported task schema");
  }
  if (
    exactlyOneTag(event, "d") !== task.id ||
    exactlyOneTag(event, "team") !== task.owningTeamId ||
    exactlyOneTag(event, "cost-centre") !== task.costCentreId ||
    exactlyOneTag(event, "initiative") !== task.initiativeId
  ) {
    return companyFailure(
      "invalid-head",
      "task head tags do not match its content",
    );
  }
  return { ok: true, value: task };
}

export function parseCohortHead(
  event: RelayEvent,
  relaySelfPubkey: string,
): CompanyParseResult<Cohort> {
  const head = readHead(event, relaySelfPubkey, KIND_COHORT);
  if (!head.ok) return head;
  const record = head.value;
  if (!matchesShape(record, COHORT_FIELDS)) {
    return companyFailure("invalid-record", "cohort record shape is invalid");
  }
  const cohort = record as unknown as Cohort;
  if (cohort.schema !== COHORT_SCHEMA) {
    return companyFailure("invalid-record", "unsupported cohort schema");
  }
  // The `m` mirror is one tag per member, so it is checked as a set against
  // the content rather than with `exactlyOneTag`: a relay-authored head must
  // carry exactly the mirrors its members imply, no more and no fewer.
  const memberMirrors = [...scalarTags(event, "m")].sort();
  const expectedMirrors = cohort.members
    .map((member) => `${member.kind}:${member.ref}`)
    .sort();
  if (
    exactlyOneTag(event, "d") !== cohort.id ||
    memberMirrors.length !== expectedMirrors.length ||
    memberMirrors.some((value, index) => value !== expectedMirrors[index])
  ) {
    return companyFailure(
      "invalid-head",
      "cohort head tags do not match its content",
    );
  }
  return { ok: true, value: cohort };
}

/**
 * NIP-01 replaceable resolution: newest `created_at` wins, and a tie is settled
 * on the lowest event ID so every client converges on the same head.
 */
export function newestHead(events: readonly RelayEvent[]): RelayEvent | null {
  let winner: RelayEvent | null = null;
  for (const event of events) {
    if (
      !winner ||
      event.created_at > winner.created_at ||
      (event.created_at === winner.created_at && event.id < winner.id)
    ) {
      winner = event;
    }
  }
  return winner;
}
