/**
 * The status pill on an agent tile.
 *
 * Five states, derived from the agent record plus whether the active-turns
 * store is currently tracking a turn for it:
 *
 * - `needs-you` — it raised an ask that is still open on the owner.
 * - `working`   — up, and mid-turn right now.
 * - `idle`      — up, nothing in flight.
 * - `deploying` — a provider-backed record whose remote worker is not up yet.
 * - `stopped`   — deliberately not running.
 */

export type AgentTileStatus =
  | "needs-you"
  | "working"
  | "idle"
  | "stopped"
  | "deploying";

export const AGENT_TILE_STATUS_LABEL: Record<AgentTileStatus, string> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
  stopped: "Stopped",
  deploying: "Deploying",
};

/**
 * Pure status derivation. `hasActiveTurn` comes from the active-turns store,
 * `hasOpenAsk` from the owner's open asks filtered to this agent.
 *
 * An open ask outranks every other state, the stopped and deploying ones
 * included: whatever the process is doing, the pill's job is to say that the
 * owner is the one holding this agent up.
 */
export function deriveAgentTileStatus(
  agent: { status: string },
  hasActiveTurn: boolean,
  hasOpenAsk = false,
): AgentTileStatus {
  if (hasOpenAsk) return "needs-you";
  if (agent.status === "running" || agent.status === "deployed") {
    return hasActiveTurn ? "working" : "idle";
  }
  if (agent.status === "not_deployed") return "deploying";
  return "stopped";
}
