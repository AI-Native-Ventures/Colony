import { invokeTauri } from "@/shared/api/tauri";

import type { CorrectionOutcome } from "./corrections";

/**
 * Publishing what a model costs.
 *
 * Rates are quoted as dollars per million tokens, because that is the unit
 * on every vendor's pricing page and retyping it in another unit is how a
 * price gets entered wrong by a factor of a thousand.
 *
 * Prices are append-only and effective-dated. Publishing a new row never
 * edits an older one, so spend already computed keeps the price that was in
 * force when it happened; a vendor's price cut or a promo ending is recorded
 * rather than backdated over history.
 */

/** A price row, as typed by a person. */
export interface PriceRequest {
  /** Model identifier exactly as the provider names it. */
  model: string;
  /** Uncached input, dollars per million tokens. */
  inputPerMtok: string;
  /** Cache reads, dollars per million tokens. */
  cacheReadPerMtok: string;
  /** 5-minute cache writes, dollars per million tokens. */
  cacheWrite5mPerMtok: string;
  /** 1-hour cache writes, dollars per million tokens. */
  cacheWrite1hPerMtok: string;
  /** Output, dollars per million tokens. */
  outputPerMtok: string;
  /** RFC 3339 instant the price takes effect; null means now. */
  effectiveFrom: string | null;
  /** Free note for whoever reads the book later. */
  note: string | null;
}

/** An empty form. Zero is a real rate, so the fields start blank, not at 0. */
export const EMPTY_PRICE: PriceRequest = {
  cacheReadPerMtok: "",
  cacheWrite1hPerMtok: "",
  cacheWrite5mPerMtok: "",
  effectiveFrom: null,
  inputPerMtok: "",
  model: "",
  note: null,
  outputPerMtok: "",
};

/** Whether a field holds a plain, non-negative dollar amount. */
export function isDollarAmount(value: string): boolean {
  return /^\d+(\.\d{1,9})?$/.test(value.trim());
}

/**
 * Why a price cannot be published yet, or `null` when it can.
 *
 * Mirrors the backend's checks so the form can say what is wrong before a
 * round trip. The backend remains the authority.
 */
export function priceProblem(request: PriceRequest): string | null {
  if (!request.model.trim()) return "Name the model this price applies to.";
  const fields: [string, string][] = [
    ["Input", request.inputPerMtok],
    ["Cache read", request.cacheReadPerMtok],
    ["5-minute cache write", request.cacheWrite5mPerMtok],
    ["1-hour cache write", request.cacheWrite1hPerMtok],
    ["Output", request.outputPerMtok],
  ];
  for (const [label, value] of fields) {
    if (!value.trim()) return `${label} needs a rate. Enter 0 if it is free.`;
    if (!isDollarAmount(value)) {
      return `${label} must be a plain dollar amount, like 3 or 0.30.`;
    }
  }
  if (
    request.effectiveFrom &&
    Number.isNaN(Date.parse(request.effectiveFrom))
  ) {
    return "That effective date cannot be read.";
  }
  return null;
}

/** Publish a price row. Throws when the relay refuses it. */
export async function publishPrice(
  request: PriceRequest,
): Promise<CorrectionOutcome> {
  const outcome = await invokeTauri<CorrectionOutcome>("ledger_add_price", {
    request: {
      ...request,
      note: request.note?.trim() || null,
    },
  });
  if (!outcome.accepted) {
    // The relay brokers this write; the commonest refusal is that this
    // identity is not the community's owner. Its own words beat a generic
    // failure.
    throw new Error(outcome.message || "The relay refused the price.");
  }
  return outcome;
}
