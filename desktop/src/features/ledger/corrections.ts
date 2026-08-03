import { invokeTauri } from "@/shared/api/tauri";

import { COMMERCIAL_PURPOSES, type CommercialPurpose } from "./contracts";

/**
 * Re-attributing spend the ledger could not place.
 *
 * A correction never rewrites the record it names. It appends to the
 * correction book, and the engine applies the last correction for a record
 * when it computes the ledger, leaving the original classification intact.
 * That is what makes the ledger auditable rather than merely current, and
 * it is why the reason is mandatory: months later it is the only thing that
 * says why a number changed.
 */

/** What the owner is asking to change. */
export interface CorrectionRequest {
  /** Hex event id of the usage record being re-attributed. */
  usageRecordEventId: string;
  /** Company charged. */
  companyId: string;
  /** Cost centre charged. */
  costCentreId: string;
  /** Team accountable. */
  owningTeamId: string;
  /** Commercial reason for the work. */
  commercialPurpose: CommercialPurpose;
  /** Client receiving the work, when this is client delivery. */
  clientOrganizationId: string | null;
  /** Task the work belonged to, when known. */
  taskId: string | null;
  /** Why the original attribution was wrong. */
  reason: string;
}

/** What the relay made of it. */
export interface CorrectionOutcome {
  /** Hex id of the submitted action event. */
  eventId: string;
  /** Whether the relay accepted it. */
  accepted: boolean;
  /** The relay's own message; shown verbatim on refusal. */
  message: string;
}

/** How each commercial purpose reads to someone who did not name it. */
export const COMMERCIAL_PURPOSE_LABELS: Record<CommercialPurpose, string> = {
  administration: "Administration",
  clientDelivery: "Client delivery",
  internalProduct: "Internal product",
  marketing: "Marketing",
  sales: "Sales",
  uncertain: "Not yet decided",
};

/** The purposes, in the order they are offered. */
export const COMMERCIAL_PURPOSE_OPTIONS: readonly CommercialPurpose[] =
  COMMERCIAL_PURPOSES;

/**
 * Why a request cannot be submitted yet, or `null` when it can.
 *
 * Checked here as well as in the backend so the form can say what is missing
 * before a round trip. The backend check is the one that matters: this is a
 * convenience, not the guard.
 */
export function correctionProblem(request: CorrectionRequest): string | null {
  if (!/^[0-9a-f]{64}$/i.test(request.usageRecordEventId)) {
    return "That record cannot be identified.";
  }
  if (!request.companyId.trim()) return "Name the company being charged.";
  if (!request.costCentreId.trim())
    return "Name the cost centre being charged.";
  if (!request.owningTeamId.trim()) return "Name the team accountable for it.";
  if (!request.reason.trim()) {
    return "Give a reason. It is the record of why this changed.";
  }
  if (
    request.commercialPurpose === "clientDelivery" &&
    !request.clientOrganizationId?.trim()
  ) {
    return "Client delivery needs the client it was delivered to.";
  }
  return null;
}

/** Submit a correction. Throws when the relay refuses it. */
export async function submitCorrection(
  request: CorrectionRequest,
): Promise<CorrectionOutcome> {
  const outcome = await invokeTauri<CorrectionOutcome>("ledger_correct", {
    request: {
      ...request,
      clientOrganizationId: request.clientOrganizationId?.trim() || null,
      taskId: request.taskId?.trim() || null,
    },
  });
  if (!outcome.accepted) {
    // The relay brokers this write and refuses it for real reasons, the
    // commonest being that this identity is not the company's owner.
    // Surfacing its own words beats a generic failure.
    throw new Error(outcome.message || "The relay refused the correction.");
  }
  return outcome;
}
