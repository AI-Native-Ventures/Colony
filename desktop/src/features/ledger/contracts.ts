import { verifyEvent } from "nostr-tools/pure";

import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_ATTRIBUTION_RULEBOOK,
  KIND_CORRECTION_BOOK,
  KIND_LEDGER_BUDGET,
  KIND_PRICE_BOOK,
} from "@/shared/constants/kinds";

/**
 * The desktop mirror of `buzz_core::ledger`.
 *
 * The ledger's whole claim is that it counts what was actually spent, so this
 * file is a boundary rather than a convenience. Rust refuses unknown fields,
 * unknown enum values, and a book head signed by anyone but the tenant relay;
 * so does this. A reader that accepted a malformed book would be presenting a
 * number nothing stands behind.
 *
 * Money is integer nanoUSD throughout, carried as `bigint`. It never becomes a
 * JavaScript number: 2^53 nanoUSD is about $9,007, which a real company passes
 * inside a year, and the failure would be silent rounding in a ledger.
 */

export const PRICE_BOOK_D_TAG = "pricebook";
export const RULEBOOK_D_TAG = "rulebook";
export const CORRECTION_BOOK_D_TAG = "corrections";

export const COMMERCIAL_PURPOSES = [
  "clientDelivery",
  "sales",
  "marketing",
  "administration",
  "internalProduct",
  "uncertain",
] as const;
export type CommercialPurpose = (typeof COMMERCIAL_PURPOSES)[number];

export const COST_CLASSIFICATIONS = ["cogs", "opex", "needsReview"] as const;
export type CostClassification = (typeof COST_CLASSIFICATIONS)[number];

export interface PriceRates {
  inputNanousdPerMtok: bigint;
  cacheReadNanousdPerMtok: bigint;
  cacheWrite5mNanousdPerMtok: bigint;
  cacheWrite1hNanousdPerMtok: bigint;
  outputNanousdPerMtok: bigint;
}

export interface PriceEntry {
  model: string;
  effectiveFrom: number;
  rates: PriceRates;
  note: string | null;
  /**
   * Who published this row.
   *
   * `owner` for anything a company published for itself, including every
   * row written before origins existed. `catalog` for Colony's maintained
   * vendor prices, which are re-applied as vendors change them and must
   * never displace an owner's own rate.
   */
  origin: PriceOrigin;
}

export interface PriceBook {
  entries: PriceEntry[];
}

export interface RuleAssignment {
  companyId: string;
  costCentreId: string;
  owningTeamId: string;
  commercialPurpose: CommercialPurpose;
  clientOrganizationId: string | null;
  taskId: string | null;
}

export interface AttributionRule {
  id: string;
  priority: number;
  matchProvider: string | null;
  matchHarness: string | null;
  matchAgentPubkey: string | null;
  matchChannelId: string | null;
  matchModel: string | null;
  assign: RuleAssignment;
}

export interface Rulebook {
  rules: AttributionRule[];
}

export interface Correction {
  id: string;
  usageRecordEventId: string;
  assign: RuleAssignment;
  reason: string;
  correctedAt: number;
}

export interface CorrectionBook {
  corrections: Correction[];
}

export interface Budget {
  costCentreId: string;
  period: string;
  amountNanousd: bigint;
}

export class LedgerContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerContractError";
  }
}

function fail(message: string): never {
  throw new LedgerContractError(message);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/** Where a price row came from. */
export type PriceOrigin = "owner" | "catalog";

/**
 * Read an entry's origin, defaulting to `owner`.
 *
 * Absent on rows written before origins existed, and those were all
 * owner-published, so the default is what keeps them beating the catalog.
 */
function parseOrigin(value: unknown, label: string): PriceOrigin {
  if (value === undefined || value === null) return "owner";
  if (value !== "owner" && value !== "catalog") {
    fail(`${label}.origin is unknown: ${String(value)}`);
  }
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(`${label} carries unknown field ${key}`);
    }
  }
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    fail(`${label}.${key} must be a non-empty string`);
  }
  return raw;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const raw = value[key];
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") fail(`${label}.${key} must be a string or null`);
  return raw;
}

/**
 * Read a whole, non-negative integer.
 *
 * JSON numbers past 2^53 have already lost precision by the time they get
 * here, so anything unsafe is refused rather than silently accepted. Money
 * fields are read by {@link requireNanousd} instead, which never goes through
 * a JavaScript number at all.
 */
function requireWholeNumber(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const raw = value[key];
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    !Number.isSafeInteger(raw)
  ) {
    fail(
      `${label}.${key} must be a whole, non-negative, exactly representable number`,
    );
  }
  return raw;
}

/**
 * Read a nanoUSD amount as `bigint`, refusing anything that already lost
 * precision.
 *
 * A number arriving above `Number.MAX_SAFE_INTEGER` cannot be trusted: JSON
 * parsing has already rounded it, and rounding money is the one thing this
 * ledger exists to prevent. Such a record is refused rather than displayed.
 */
function requireNanousd(
  value: Record<string, unknown>,
  key: string,
  label: string,
): bigint {
  const raw = value[key];
  if (typeof raw === "string") {
    if (!/^\d+$/.test(raw))
      fail(`${label}.${key} must be a whole nanoUSD amount`);
    return BigInt(raw);
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    fail(`${label}.${key} must be a whole, non-negative nanoUSD amount`);
  }
  if (!Number.isSafeInteger(raw)) {
    fail(
      `${label}.${key} exceeds exact integer range, so its value is already ` +
        `approximate and cannot be shown as money`,
    );
  }
  return BigInt(raw);
}

const RATE_KEYS = [
  "inputNanousdPerMtok",
  "cacheReadNanousdPerMtok",
  "cacheWrite5mNanousdPerMtok",
  "cacheWrite1hNanousdPerMtok",
  "outputNanousdPerMtok",
] as const;

function parseRates(value: unknown, label: string): PriceRates {
  const raw = asObject(value, label);
  requireExactKeys(raw, RATE_KEYS, label);
  return {
    inputNanousdPerMtok: requireNanousd(raw, "inputNanousdPerMtok", label),
    cacheReadNanousdPerMtok: requireNanousd(
      raw,
      "cacheReadNanousdPerMtok",
      label,
    ),
    cacheWrite5mNanousdPerMtok: requireNanousd(
      raw,
      "cacheWrite5mNanousdPerMtok",
      label,
    ),
    cacheWrite1hNanousdPerMtok: requireNanousd(
      raw,
      "cacheWrite1hNanousdPerMtok",
      label,
    ),
    outputNanousdPerMtok: requireNanousd(raw, "outputNanousdPerMtok", label),
  };
}

function parseAssignment(value: unknown, label: string): RuleAssignment {
  const raw = asObject(value, label);
  requireExactKeys(
    raw,
    [
      "companyId",
      "costCentreId",
      "owningTeamId",
      "commercialPurpose",
      "clientOrganizationId",
      "taskId",
    ],
    label,
  );
  const purpose = requireString(raw, "commercialPurpose", label);
  if (!(COMMERCIAL_PURPOSES as readonly string[]).includes(purpose)) {
    fail(`${label}.commercialPurpose is unknown: ${purpose}`);
  }
  return {
    companyId: requireString(raw, "companyId", label),
    costCentreId: requireString(raw, "costCentreId", label),
    owningTeamId: requireString(raw, "owningTeamId", label),
    commercialPurpose: purpose as CommercialPurpose,
    clientOrganizationId: optionalString(raw, "clientOrganizationId", label),
    taskId: optionalString(raw, "taskId", label),
  };
}

/**
 * Assert that a book head was authored by the tenant relay and is intact.
 *
 * A client never signs a book. One that verifies under any other key is either
 * a forgery or a bug, and either way its numbers mean nothing.
 */
function requireRelayAuthoredHead(
  event: RelayEvent,
  relayPubkey: string,
  kind: number,
  dTag: string,
  label: string,
): void {
  if (event.kind !== kind) {
    fail(`${label} has kind ${event.kind}, expected ${kind}`);
  }
  if (event.pubkey.toLowerCase() !== relayPubkey.toLowerCase()) {
    fail(`${label} was not authored by the tenant relay`);
  }
  const identifiers = event.tags.filter((tag) => tag[0] === "d");
  if (identifiers.length !== 1 || identifiers[0]?.[1] !== dTag) {
    fail(`${label} must carry exactly one d tag of ${dTag}`);
  }
  if (!verifyEvent(event as Parameters<typeof verifyEvent>[0])) {
    fail(`${label} signature does not verify`);
  }
}

function parseContent(
  event: RelayEvent,
  label: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.content);
  } catch (error) {
    fail(`${label} content is not JSON: ${String(error)}`);
  }
  return asObject(parsed, `${label} content`);
}

export function parsePriceBook(
  event: RelayEvent,
  relayPubkey: string,
): PriceBook {
  const label = "price book";
  requireRelayAuthoredHead(
    event,
    relayPubkey,
    KIND_PRICE_BOOK,
    PRICE_BOOK_D_TAG,
    label,
  );
  const content = parseContent(event, label);
  requireExactKeys(content, ["entries"], label);
  const entries = content.entries;
  if (!Array.isArray(entries)) fail(`${label}.entries must be an array`);

  return {
    entries: entries.map((entry, index) => {
      const entryLabel = `${label}.entries[${index}]`;
      const raw = asObject(entry, entryLabel);
      requireExactKeys(
        raw,
        ["model", "effectiveFrom", "rates", "note", "origin"],
        entryLabel,
      );
      return {
        model: requireString(raw, "model", entryLabel),
        effectiveFrom: requireWholeNumber(raw, "effectiveFrom", entryLabel),
        rates: parseRates(raw.rates, `${entryLabel}.rates`),
        note: optionalString(raw, "note", entryLabel),
        origin: parseOrigin(raw.origin, entryLabel),
      };
    }),
  };
}

export function parseRulebook(
  event: RelayEvent,
  relayPubkey: string,
): Rulebook {
  const label = "rulebook";
  requireRelayAuthoredHead(
    event,
    relayPubkey,
    KIND_ATTRIBUTION_RULEBOOK,
    RULEBOOK_D_TAG,
    label,
  );
  const content = parseContent(event, label);
  requireExactKeys(content, ["rules"], label);
  const rules = content.rules;
  if (!Array.isArray(rules)) fail(`${label}.rules must be an array`);

  return {
    rules: rules.map((rule, index) => {
      const ruleLabel = `${label}.rules[${index}]`;
      const raw = asObject(rule, ruleLabel);
      requireExactKeys(
        raw,
        [
          "id",
          "priority",
          "matchProvider",
          "matchHarness",
          "matchAgentPubkey",
          "matchChannelId",
          "matchModel",
          "assign",
        ],
        ruleLabel,
      );
      return {
        id: requireString(raw, "id", ruleLabel),
        priority: requireWholeNumber(raw, "priority", ruleLabel),
        matchProvider: optionalString(raw, "matchProvider", ruleLabel),
        matchHarness: optionalString(raw, "matchHarness", ruleLabel),
        matchAgentPubkey: optionalString(raw, "matchAgentPubkey", ruleLabel),
        matchChannelId: optionalString(raw, "matchChannelId", ruleLabel),
        matchModel: optionalString(raw, "matchModel", ruleLabel),
        assign: parseAssignment(raw.assign, `${ruleLabel}.assign`),
      };
    }),
  };
}

export function parseCorrectionBook(
  event: RelayEvent,
  relayPubkey: string,
): CorrectionBook {
  const label = "correction book";
  requireRelayAuthoredHead(
    event,
    relayPubkey,
    KIND_CORRECTION_BOOK,
    CORRECTION_BOOK_D_TAG,
    label,
  );
  const content = parseContent(event, label);
  requireExactKeys(content, ["corrections"], label);
  const corrections = content.corrections;
  if (!Array.isArray(corrections))
    fail(`${label}.corrections must be an array`);

  return {
    corrections: corrections.map((correction, index) => {
      const correctionLabel = `${label}.corrections[${index}]`;
      const raw = asObject(correction, correctionLabel);
      requireExactKeys(
        raw,
        ["id", "usageRecordEventId", "assign", "reason", "correctedAt"],
        correctionLabel,
      );
      const recordId = requireString(
        raw,
        "usageRecordEventId",
        correctionLabel,
      );
      if (!/^[0-9a-f]{64}$/i.test(recordId)) {
        fail(`${correctionLabel}.usageRecordEventId must be a 64-hex event id`);
      }
      return {
        id: requireString(raw, "id", correctionLabel),
        usageRecordEventId: recordId.toLowerCase(),
        assign: parseAssignment(raw.assign, `${correctionLabel}.assign`),
        reason: requireString(raw, "reason", correctionLabel),
        correctedAt: requireWholeNumber(raw, "correctedAt", correctionLabel),
      };
    }),
  };
}

/** The `d` tag addressing one cost centre's budget for one period. */
export function budgetDTag(costCentreId: string, period: string): string {
  return `${costCentreId}:${period}`;
}

export function parseBudget(event: RelayEvent, relayPubkey: string): Budget {
  const label = "budget";
  const content = parseContent(event, label);
  requireExactKeys(content, ["costCentreId", "period", "amountNanousd"], label);
  const costCentreId = requireString(content, "costCentreId", label);
  const period = requireString(content, "period", label);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    fail(`${label}.period must be YYYY-MM`);
  }
  requireRelayAuthoredHead(
    event,
    relayPubkey,
    KIND_LEDGER_BUDGET,
    budgetDTag(costCentreId, period),
    label,
  );
  return {
    costCentreId,
    period,
    amountNanousd: requireNanousd(content, "amountNanousd", label),
  };
}

/**
 * Render a nanoUSD amount as a dollar string.
 *
 * Done with integer arithmetic on the `bigint`, never by dividing into a
 * float. Sub-cent amounts are common for a single call, so they round to two
 * decimals for display while the underlying value stays exact.
 */
export function formatNanousd(amount: bigint): string {
  const NANOS_PER_CENT = 10_000_000n;
  const cents = amount / NANOS_PER_CENT;
  const remainder = amount % NANOS_PER_CENT;
  // Round half up on the cent, so a displayed total never reads lower than
  // what was actually spent.
  const rounded = remainder * 2n >= NANOS_PER_CENT ? cents + 1n : cents;
  const dollars = rounded / 100n;
  const fraction = rounded % 100n;
  const grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${grouped}.${fraction.toString().padStart(2, "0")}`;
}
