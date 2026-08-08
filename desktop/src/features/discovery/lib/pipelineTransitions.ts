import { LEAD_STATUS_TRANSITIONS } from "@/features/parties/contracts";
import type { RelationshipStatus } from "@/features/parties/contracts";
import type { LeadFunnelStatus } from "../types";
import { PIPELINE_COLUMN_STATUSES } from "../types";

/** Column headings in lifecycle order, matching the funnel vocabulary. */
export const PIPELINE_COLUMN_LABELS: Record<LeadFunnelStatus, string> = {
  candidate: "Candidate",
  accepted: "Accepted",
  qualified: "Qualified",
  dormant: "Dormant",
  disqualified: "Disqualified",
  client_active: "Converted",
};

/**
 * The relay's `RelationshipStatus` Debug label for a funnel status.
 *
 * Used to reproduce the relay's refusal wording (`Lead status transition
 * Disqualified -> Accepted is not allowed`) in the demo source. A Lead can
 * never reach `active`, so `client_active` only maps for completeness.
 */
export function relationshipLabel(status: LeadFunnelStatus): string {
  return status === "client_active" ? "Active" : PIPELINE_COLUMN_LABELS[status];
}

function toRelationshipStatus(status: LeadFunnelStatus): RelationshipStatus {
  return status === "client_active" ? "active" : status;
}

/**
 * Whether the relay permits a Lead move between two funnel statuses.
 *
 * Presentation mirror only: the relay decides legality at ingest and its
 * refusal reason is shown inline when it disagrees.
 */
export function canMoveLead(
  from: LeadFunnelStatus,
  to: LeadFunnelStatus,
): boolean {
  return LEAD_STATUS_TRANSITIONS[toRelationshipStatus(from)].includes(
    toRelationshipStatus(to),
  );
}

/** The move options a card in `from` shows, in lifecycle order. */
export function pipelineMoveTargets(
  from: LeadFunnelStatus,
): LeadFunnelStatus[] {
  return PIPELINE_COLUMN_STATUSES.filter(
    (target) => target !== from && canMoveLead(from, target),
  );
}
