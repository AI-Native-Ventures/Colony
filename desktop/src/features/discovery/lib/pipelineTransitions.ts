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

/** One option in a status control: what to render and whether it is offerable. */
export type StatusMoveOption = {
  status: LeadFunnelStatus;
  label: string;
  legal: boolean;
};

/**
 * Every option a status control renders for a lead in `from`, in lifecycle
 * order, with illegal ones marked rather than dropped.
 *
 * Shared by the Pipeline card and the drawer control so the two cannot offer
 * different moves for the same lead. Illegal targets stay in the list because
 * showing a greyed-out move tells the user the funnel has a shape; hiding it
 * just looks like the option does not exist.
 *
 * The lead's own status is excluded (a no-op move is not a move to offer), and
 * so is `client_active`: a Lead can never belong to `active`, so the relay
 * refuses it at the `belongs_to` guard before the matrix is consulted. Rendering
 * it as "not allowed" would imply Converted is a move somebody could earn, and
 * it is not. Conversion needs its own design.
 */
export function statusMoveOptions(from: LeadFunnelStatus): StatusMoveOption[] {
  const targets = pipelineMoveTargets(from);
  return PIPELINE_COLUMN_STATUSES.filter(
    (status) => status !== from && status !== "client_active",
  ).map((status) => ({
    status,
    label: PIPELINE_COLUMN_LABELS[status],
    legal: targets.includes(status),
  }));
}
