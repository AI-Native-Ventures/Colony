import type { ManagedAgent } from "@/shared/api/types";

/**
 * Whether an agent is one Colony provides, and therefore not this workspace's
 * to edit or delete.
 *
 * The UI hides those controls, but hiding a control is a courtesy rather than
 * the guarantee. `update_managed_agent` and `delete_managed_agent` both refuse
 * a provisioned agent with a reason, and the relay refuses every destructive
 * path at ingest no matter what any client sends. This exists so the app does
 * not offer an action it already knows will be turned down.
 */
export function isProvisionedAgent(
  agent: ManagedAgent | null | undefined,
): boolean {
  const handle = agent?.provisioned;
  return typeof handle === "string" && handle.trim().length > 0;
}

/**
 * What the delete row says for an agent Colony provides.
 *
 * Mirrors the "Managed by team" row beside it: the item stays visible and
 * disabled rather than vanishing, because a missing control reads as a bug
 * while a disabled one with a reason reads as a decision.
 */
export const PROVISIONED_DELETE_LABEL = "Provided by Colony";
