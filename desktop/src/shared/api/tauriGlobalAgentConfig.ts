import { invokeTauri } from "@/shared/api/tauri";
import type {
  GlobalAgentConfig,
  GlobalAgentConfigSaveResult,
} from "@/shared/api/types";

/**
 * Read the current global agent configuration defaults.
 *
 * Returns an empty default if the file has not been written yet.
 */
export async function getGlobalAgentConfig(): Promise<GlobalAgentConfig> {
  return invokeTauri<GlobalAgentConfig>("get_global_agent_config");
}

/** Native account and business captured before an onboarding save begins. */
export type GlobalAgentConfigScope = {
  ownerPubkey: string;
  relayUrl: string;
};

/**
 * Validate and persist a new global agent configuration.
 *
 * The backend strips empty env values (empty = "inherit"), validates key
 * shape and reserved-key rules, restarts running local agents whose effective
 * env changed, and returns the saved config with a restart count.
 *
 * A supplied scope is checked natively under the context locks before writing;
 * its restarts only affect that account and business. Existing callers may omit it.
 * Throws a string error message on validation failure or a stale scope.
 */
export async function setGlobalAgentConfig(
  config: GlobalAgentConfig,
  scope?: GlobalAgentConfigScope,
): Promise<GlobalAgentConfigSaveResult> {
  return invokeTauri<GlobalAgentConfigSaveResult>("set_global_agent_config", {
    config,
    ...(scope
      ? {
          expectedOwnerPubkey: scope.ownerPubkey,
          expectedRelayUrl: scope.relayUrl,
        }
      : {}),
  });
}
