import type { ManagedAgent } from "@/shared/api/types";

/**
 * Agents that carry no community pin.
 *
 * A blank pin means the record predates the community boundary: it is one
 * record shown in every community's roster, so deleting it in one community
 * removes it from all of them. Assigning it is how that record becomes an
 * agent of exactly one community.
 *
 * Kept separate from the component so the "which agents are shared" rule has
 * one definition and can be tested without rendering.
 */
export function selectUnassignedAgents(
  agents: readonly ManagedAgent[],
): ManagedAgent[] {
  return agents.filter((agent) => agent.relayUrl.trim() === "");
}
