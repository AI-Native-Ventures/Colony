/**
 * The status pill on an agent tile.
 *
 * Four states, derived from the agent record plus whether the active-turns
 * store is currently tracking a turn for it:
 *
 * - `working`   — up, and mid-turn right now.
 * - `idle`      — up, nothing in flight.
 * - `deploying` — a provider-backed record whose remote worker is not up yet.
 * - `stopped`   — deliberately not running.
 */

export type AgentTileStatus = "working" | "idle" | "stopped" | "deploying";

export const AGENT_TILE_STATUS_LABEL: Record<AgentTileStatus, string> = {
  working: "Working",
  idle: "Idle",
  stopped: "Stopped",
  deploying: "Deploying",
};

/** Pure status derivation. `hasActiveTurn` comes from the active-turns store. */
export function deriveAgentTileStatus(
  agent: { status: string },
  hasActiveTurn: boolean,
): AgentTileStatus {
  if (agent.status === "running" || agent.status === "deployed") {
    return hasActiveTurn ? "working" : "idle";
  }
  if (agent.status === "not_deployed") return "deploying";
  return "stopped";
}
