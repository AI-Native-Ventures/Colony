/**
 * Pure resolvers behind the agent tile's header chips.
 *
 * Each one answers a single question about a managed agent record so the tile
 * body stays a renderer: which harness is this, which efforts may it be set to,
 * and which worktree is it working in.
 */
import {
  BUZZ_AGENT_THINKING_EFFORT,
  getProviderEffortConfig,
} from "@/features/agents/ui/buzzAgentConfig";

/** Env var carrying the worktree a Factory agent was launched into. */
export const COLONY_WORKTREE_ENV_VAR = "COLONY_WORKTREE";

export type AgentHarnessChip = {
  /** Catalog runtime id, or null when the agent inherits its harness. */
  id: string | null;
  label: string;
};

/**
 * The harness chip's id and label.
 *
 * `agent.runtime` is the explicit pin; a null pin means the agent inherits from
 * its persona, and the only thing left that names the harness is the resolved
 * command, so its basename is the label rather than a bare "Inherited".
 */
export function resolveAgentHarnessChip(
  agent: { runtime?: string | null; agentCommand?: string | null },
  runtimes: ReadonlyArray<{ id: string; label: string }> = [],
): AgentHarnessChip {
  const id = agent.runtime?.trim() || null;
  if (id) {
    const entry = runtimes.find(
      (candidate) => candidate.id.trim().toLowerCase() === id.toLowerCase(),
    );
    return { id, label: entry?.label ?? id };
  }
  const command = agent.agentCommand?.trim() ?? "";
  const basename = command.split(/[\\/]/).pop() ?? "";
  return { id: null, label: basename || "Harness" };
}

export type AgentEffortChip = {
  /** Currently pinned effort, or "" when the agent inherits one. */
  current: string;
  /** Efforts this provider/model accepts, weakest first. */
  options: ReadonlyArray<string>;
};

/**
 * Efforts the agent's provider and model accept, plus the pinned value.
 *
 * `options` is empty when the combination advertises no effort axis at all —
 * the caller hides the chip rather than rendering an empty menu, because
 * nothing to choose is not the same as a choice that failed to load.
 */
export function resolveAgentEffortChip(agent: {
  provider?: string | null;
  model?: string | null;
  envVars?: Record<string, string> | null;
}): AgentEffortChip {
  const config = getProviderEffortConfig(
    agent.provider ?? "",
    agent.model ?? undefined,
  );
  return {
    current: agent.envVars?.[BUZZ_AGENT_THINKING_EFFORT] ?? "",
    options: config.validValues,
  };
}

/**
 * Replace the effort key in an env-var map.
 *
 * The update mutation replaces `envVars` wholesale, so this returns the full
 * next map. An empty selection deletes the key rather than storing `""`, which
 * is what "inherit" means to the backend.
 */
export function applyEffortToEnvVars(
  envVars: Record<string, string> | null | undefined,
  effort: string,
): Record<string, string> {
  const next = { ...(envVars ?? {}) };
  if (effort) {
    next[BUZZ_AGENT_THINKING_EFFORT] = effort;
  } else {
    delete next[BUZZ_AGENT_THINKING_EFFORT];
  }
  return next;
}

/** The worktree chip's label: the leaf directory name, or null when unset. */
export function resolveAgentWorktreeLabel(
  envVars: Record<string, string> | null | undefined,
): string | null {
  const raw = envVars?.[COLONY_WORKTREE_ENV_VAR]?.trim();
  if (!raw) return null;
  const leaf = raw
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop();
  return leaf || raw;
}
