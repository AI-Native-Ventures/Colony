import { invokeTauri } from "@/shared/api/tauri";

import { LedgerContractError, type RuleAssignment } from "./contracts";

/**
 * The computed cost ledger, as the Tauri backend hands it over.
 *
 * The arithmetic happens in `buzz_core::ledger`, not here. Usage records are
 * NIP-44 ciphertext addressed to the owner, so only the backend can read
 * them, and a second engine in TypeScript would let the two disagree about
 * what a company spent.
 *
 * Money crosses as decimal strings and is parsed to `bigint` here. nanoUSD
 * passes `Number.MAX_SAFE_INTEGER` at about $9,007, which a real company
 * spends inside a year; a JSON number would already be rounded by the time
 * this module saw it, and nothing downstream could tell.
 */

/** How the engine established an entry's attribution. */
export type AttributionMethod =
  | { kind: "explicit" }
  | { kind: "rule"; id: string }
  | { kind: "correction"; id: string }
  | { kind: "needsReview" };

/** Whether real money moved, or a subscription covered it. */
export type PaymentMode = "metered" | "imputed";

/** How the usage evidence was captured. */
export type UsageSource = "wire" | "adapter_estimate" | "manual";

/** Accounting classification in force for an entry. */
export type EntryClassification = "cogs" | "opex" | "needsReview";

/**
 * Where a call's cost came from.
 *
 * The same model costs different amounts from the lab that trained it, from a
 * cloud reselling it, and from a router. `listRow` means the book had no row
 * for this call's provider and the vendor's list price was used instead.
 *
 * `observed` is not a row at all: the provider stated what it charged, on the
 * call itself. That beats every rate we hold, because it is the charge rather
 * than a model of the charge.
 */
export type PriceBasis = "observed" | "providerRow" | "listRow";

/** One priced, attributed usage record. */
export interface LedgerEntry {
  /** Hex event id of the underlying usage record. */
  eventId: string;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Provider slug, e.g. `anthropic`. */
  provider: string;
  /** Model, when the record was token-priced. */
  model: string | null;
  /** Metered (real money) or imputed (subscription shadow cost). */
  paymentMode: PaymentMode;
  /** Wire evidence, adapter estimate, or an explicit manual amount. */
  source: UsageSource;
  /**
   * Cost in nanoUSD, or `null` when no price covers the model.
   *
   * `null` is not zero. Zero would claim the call was free; `null` says the
   * cost is not yet knowable, which is why it also forces review.
   */
  costNanousd: bigint | null;
  /**
   * Which kind of price row supplied the rate.
   *
   * `providerRow` means a row named the provider that served this call, so
   * the rate is what that provider charges. `listRow` means the vendor's list
   * price was used, which is right for a call the vendor served itself and
   * wrong by the reseller's margin otherwise.
   *
   * `null` for unpriced and flat-amount records, which consulted no book.
   */
  priceBasis: PriceBasis | null;
  /** Classification before any correction. Never changes. */
  originalClassification: EntryClassification;
  /** Classification in force now, after corrections. */
  effectiveClassification: EntryClassification;
  /** Assignment in force now, when one was established. */
  effectiveAssignment: RuleAssignment | null;
  /** How the effective attribution was established. */
  attributedBy: AttributionMethod;
}

/** Spend totals by accounting classification. */
export interface ClassTotals {
  /** Direct client delivery. */
  cogs: bigint;
  /** Internal operating expense. */
  opex: bigint;
  /** Money the engine could not place. */
  needsReview: bigint;
}

/** Spend attributed to one cost centre. */
export interface CostCentreTotal {
  /** Cost centre, or `needs-review` for unattributed money. */
  costCentreId: string;
  /** Spend in nanoUSD. */
  amountNanousd: bigint;
}

/** Metered spend for one provider on one UTC day. */
export interface DailySum {
  /** Provider slug. */
  provider: string;
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Metered spend in nanoUSD. */
  meteredNanousd: bigint;
}

/** A budget and what was actually spent against it. */
export interface BudgetStatus {
  /** Cost centre the budget governs. */
  costCentreId: string;
  /** Month, `YYYY-MM`. */
  period: string;
  /** The limit in nanoUSD. */
  budgetNanousd: bigint;
  /** Spend recorded against it in nanoUSD. */
  actualNanousd: bigint;
}

/** Something the engine could not resolve, with its plain-language reading. */
export interface LedgerException {
  /** Discriminator, e.g. `unpricedModel`. */
  type: string;
  /** What it most likely means, when the engine can say. */
  diagnosis: string | null;
  /** The exception's own fields, as the engine emitted them. */
  detail: Record<string, unknown>;
}

/** The full computed ledger. */
export interface LedgerReport {
  /** One entry per counted record, oldest first. */
  entries: LedgerEntry[];
  /** Totals by effective classification. */
  totals: ClassTotals;
  /** Real money spent. */
  meteredNanousd: bigint;
  /** Subscription-backed spend at API-equivalent prices. */
  imputedNanousd: bigint;
  /** Spend per cost centre; unattributed money sits under `needs-review`. */
  byCostCentre: CostCentreTotal[];
  /** Metered wire spend per provider-day. */
  byDay: DailySum[];
  /** Budgets and their actuals. */
  budgetStatus: BudgetStatus[];
  /** Everything the engine could not resolve. */
  exceptions: LedgerException[];
  /**
   * Records addressed to this owner that could not be read.
   *
   * Surfaced rather than dropped: a total computed over fewer records than
   * exist is understated, and the screen has to be able to say so.
   */
  unreadableRecords: number;
  /** True when no price book exists at all, so every model is unpriced. */
  priceBookMissing: boolean;
}

/** Cost centre key the engine uses for money it could not attribute. */
export const NEEDS_REVIEW_COST_CENTRE = "needs-review";

function fail(message: string): never {
  throw new LedgerContractError(`ledger report: ${message}`);
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`${what} must be an array`);
  return value;
}

function requireString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value !== "string") fail(`${key} must be a string`);
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(`${key} must be a string or null`);
  return value;
}

/**
 * Parse a nanoUSD amount from its decimal-string form.
 *
 * Digits only. A number arriving here would mean the backend changed its
 * wire format to one that silently rounds, so it is refused rather than
 * coerced.
 */
function requireNanousd(source: Record<string, unknown>, key: string): bigint {
  const value = source[key];
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    fail(`${key} must be a nanoUSD amount as a decimal string`);
  }
  return BigInt(value);
}

function optionalNanousd(
  source: Record<string, unknown>,
  key: string,
): bigint | null {
  const value = source[key];
  if (value === null || value === undefined) return null;
  return requireNanousd(source, key);
}

const CLASSIFICATIONS = new Set(["cogs", "opex", "needsReview"]);

function requireClassification(
  source: Record<string, unknown>,
  key: string,
): EntryClassification {
  const value = requireString(source, key);
  if (!CLASSIFICATIONS.has(value)) fail(`${key} is unknown: ${value}`);
  return value as EntryClassification;
}

const PRICE_BASES = new Set(["observed", "providerRow", "listRow"]);

/**
 * Absent is the normal case for an unpriced or flat-amount record, and also
 * for any report produced before the basis existed, so it reads as "not
 * stated" rather than failing. An unrecognised value does fail: silently
 * dropping a basis the app does not understand would show a rate as
 * provider-specific when it may not be.
 */
function parsePriceBasis(value: unknown): PriceBasis | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !PRICE_BASES.has(value)) {
    return fail(`priceBasis is unknown: ${String(value)}`);
  }
  return value as PriceBasis;
}

function parseAttributedBy(value: unknown): AttributionMethod {
  const raw = asObject(value, "attributedBy");
  const kind = requireString(raw, "kind");
  switch (kind) {
    case "explicit":
    case "needsReview":
      return { kind };
    case "rule":
    case "correction":
      return { kind, id: requireString(raw, "id") };
    default:
      return fail(`attributedBy.kind is unknown: ${kind}`);
  }
}

function parseAssignment(value: unknown): RuleAssignment {
  const raw = asObject(value, "effectiveAssignment");
  return {
    clientOrganizationId: optionalString(raw, "clientOrganizationId"),
    commercialPurpose: requireString(
      raw,
      "commercialPurpose",
    ) as RuleAssignment["commercialPurpose"],
    companyId: requireString(raw, "companyId"),
    costCentreId: requireString(raw, "costCentreId"),
    owningTeamId: requireString(raw, "owningTeamId"),
    taskId: optionalString(raw, "taskId"),
  };
}

function parseEntry(value: unknown): LedgerEntry {
  const raw = asObject(value, "entry");
  const paymentMode = requireString(raw, "paymentMode");
  if (paymentMode !== "metered" && paymentMode !== "imputed") {
    fail(`paymentMode is unknown: ${paymentMode}`);
  }
  const source =
    raw.source === undefined ? "wire" : requireString(raw, "source");
  if (
    source !== "wire" &&
    source !== "adapter_estimate" &&
    source !== "manual"
  ) {
    fail(`source is unknown: ${source}`);
  }
  return {
    attributedBy: parseAttributedBy(raw.attributedBy),
    costNanousd: optionalNanousd(raw, "costNanousd"),
    day: requireString(raw, "day"),
    effectiveAssignment:
      raw.effectiveAssignment === null || raw.effectiveAssignment === undefined
        ? null
        : parseAssignment(raw.effectiveAssignment),
    effectiveClassification: requireClassification(
      raw,
      "effectiveClassification",
    ),
    eventId: requireString(raw, "eventId"),
    model: optionalString(raw, "model"),
    originalClassification: requireClassification(
      raw,
      "originalClassification",
    ),
    paymentMode,
    priceBasis: parsePriceBasis(raw.priceBasis),
    provider: requireString(raw, "provider"),
    source,
  };
}

function parseException(value: unknown): LedgerException {
  const raw = asObject(value, "exception");
  const detail = asObject(raw.exception, "exception.exception");
  const diagnosis = raw.diagnosis;
  if (
    diagnosis !== null &&
    diagnosis !== undefined &&
    typeof diagnosis !== "string"
  ) {
    fail("exception.diagnosis must be a string or null");
  }
  return {
    detail,
    diagnosis: (diagnosis as string | null | undefined) ?? null,
    type: requireString(detail, "type"),
  };
}

/**
 * Parse the backend's report.
 *
 * Strict on money and on enum members: a shape this module does not
 * recognize means the backend and the screen disagree, and showing a
 * half-understood number as spend is worse than showing an error.
 */
export function parseLedgerReport(value: unknown): LedgerReport {
  const raw = asObject(value, "report");
  const totals = asObject(raw.totals, "totals");
  const unreadable = raw.unreadableRecords;
  if (typeof unreadable !== "number" || !Number.isSafeInteger(unreadable)) {
    fail("unreadableRecords must be a whole number");
  }
  if (typeof raw.priceBookMissing !== "boolean") {
    fail("priceBookMissing must be a boolean");
  }

  return {
    budgetStatus: asArray(raw.budgetStatus, "budgetStatus").map((item) => {
      const status = asObject(item, "budgetStatus entry");
      return {
        actualNanousd: requireNanousd(status, "actualNanousd"),
        budgetNanousd: requireNanousd(status, "budgetNanousd"),
        costCentreId: requireString(status, "costCentreId"),
        period: requireString(status, "period"),
      };
    }),
    byCostCentre: asArray(raw.byCostCentre, "byCostCentre").map((item) => {
      const total = asObject(item, "byCostCentre entry");
      return {
        amountNanousd: requireNanousd(total, "amountNanousd"),
        costCentreId: requireString(total, "costCentreId"),
      };
    }),
    byDay: asArray(raw.byDay, "byDay").map((item) => {
      const sum = asObject(item, "byDay entry");
      return {
        day: requireString(sum, "day"),
        meteredNanousd: requireNanousd(sum, "meteredNanousd"),
        provider: requireString(sum, "provider"),
      };
    }),
    entries: asArray(raw.entries, "entries").map(parseEntry),
    exceptions: asArray(raw.exceptions, "exceptions").map(parseException),
    imputedNanousd: requireNanousd(raw, "imputedNanousd"),
    meteredNanousd: requireNanousd(raw, "meteredNanousd"),
    priceBookMissing: raw.priceBookMissing,
    totals: {
      cogs: requireNanousd(totals, "cogs"),
      needsReview: requireNanousd(totals, "needsReview"),
      opex: requireNanousd(totals, "opex"),
    },
    unreadableRecords: unreadable,
  };
}

/** Compute the company's cost ledger in the Tauri backend. */
export async function loadLedgerReport(): Promise<LedgerReport> {
  return parseLedgerReport(await invokeTauri<unknown>("ledger_report"));
}

/**
 * A one-line reading of an exception, for a reader who does not know the
 * ledger's internals.
 *
 * The backend already supplies a diagnosis for reconciliation drift, where
 * the direction of the gap is the diagnosis. This covers the rest.
 */
export function describeException(exception: LedgerException): string {
  if (exception.diagnosis) return exception.diagnosis;
  switch (exception.type) {
    case "unpricedModel":
      return `No price is on file for ${String(exception.detail.model ?? "this model")}, so its cost is unknown and its spend is unattributed. Add a price to count it.`;
    case "duplicateConflict":
      return "Two records claimed the same provider call with different content. The first was counted; the second was set aside.";
    case "badTimestamp":
      return "A record's timestamp could not be read, so the time it was published was used for pricing instead.";
    default:
      return "The ledger could not resolve this on its own.";
  }
}
