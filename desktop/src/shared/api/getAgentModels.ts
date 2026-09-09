import { invokeTauri } from "./tauri";
import type { AgentModelsResponse } from "./types";

/** Discover defaults or the runtime's scoped next-reply catalog. */
export async function getAgentModels(pubkey: string, replyScope = false) {
  return invokeTauri<AgentModelsResponse>("get_agent_models", {
    pubkey,
    replyScope,
  });
}
