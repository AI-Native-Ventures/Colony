/**
 * Constants shared by the global agent config fields.
 *
 * They live outside `AgentConfigFields` because that file sits on the desktop
 * file-size ratchet, and a constant is the cheapest thing to move out of it.
 */
import type { GlobalAgentConfig } from "@/shared/api/types";
import { BUZZ_AGENT_THINKING_EFFORT } from "@/features/agents/ui/buzzAgentConfig";

/** A config with nothing chosen yet: every agent runs on the baked floor. */
export const EMPTY_GLOBAL_CONFIG: GlobalAgentConfig = {
  credential_mode: "byok",
  env_vars: {},
  fallback_models: [],
  provider: null,
  model: null,
  preferred_runtime: null,
};

/** Baked env keys a structured field owns, so they never show as generic rows. */
export const BAKED_STRUCTURED_KEYS = new Set([
  "BUZZ_AGENT_PROVIDER",
  "BUZZ_AGENT_MODEL",
  BUZZ_AGENT_THINKING_EFFORT,
]);
