import type {
  AcpRuntimeCatalogEntry,
  GlobalAgentConfig,
} from "@/shared/api/types";
import { runtimeIsReadyForOnboarding } from "./ui/onboardingRuntimeSelection";

const AUTOMATIC_CLI_ORDER = ["codex", "claude", "omp", "opencode"] as const;
export const COLONY_AGENT_RUNTIME_ID = "buzz-agent";

export type AutomaticRuntimeChoice =
  | { route: "cli"; runtimeId: string }
  | { route: "colony-agent"; runtimeId: typeof COLONY_AGENT_RUNTIME_ID };

export function selectAutomaticRuntime(
  runtimes: readonly AcpRuntimeCatalogEntry[],
): AutomaticRuntimeChoice {
  const readyIds = new Set(
    runtimes.filter(runtimeIsReadyForOnboarding).map((runtime) => runtime.id),
  );
  const runtimeId = AUTOMATIC_CLI_ORDER.find((id) => readyIds.has(id));
  return runtimeId
    ? { route: "cli", runtimeId }
    : { route: "colony-agent", runtimeId: COLONY_AGENT_RUNTIME_ID };
}

export function configForAutomaticCli(
  current: GlobalAgentConfig,
  runtimeId: string,
): GlobalAgentConfig {
  return {
    ...current,
    credential_mode: "byok",
    preferred_runtime: runtimeId,
  };
}

/**
 * The hosted route: the bundled Colony Agent, paid for with Colony Credits.
 *
 * The provider is the OpenAI-compatible dialect even though the model is
 * DeepSeek's, because Colony Credits routes every call through the relay's
 * OpenAI-dialect gateway rather than to the vendor. Both gates that decide
 * whether that is allowed accept `buzz-agent` only on `openai` or
 * `openai-compat`: `isColonyCreditsEligible`, which the Settings switch reads,
 * and the spawn preflight in `managed_agents/runtime/provisioned.rs`, which
 * refuses the start outright. A `deepseek` provider here therefore wrote a
 * config no agent could start on, which reads as a team that never speaks.
 *
 * No `OPENAI_COMPAT_BASE_URL` either, and an inherited one is dropped: under
 * Colony Credits the upstream is the relay's gateway, supplied with the lease
 * at spawn. A vendor URL sends the agent straight to DeepSeek carrying a
 * Colony gateway token, which DeepSeek rejects.
 */
export function defaultColonyAgentConfig(
  current: GlobalAgentConfig = {
    credential_mode: "byok",
    env_vars: {},
    provider: null,
    model: null,
    preferred_runtime: null,
  },
): GlobalAgentConfig {
  const { OPENAI_COMPAT_BASE_URL: _vendorBaseUrl, ...envVars } =
    current.env_vars;
  return {
    ...current,
    credential_mode: "colony_credits",
    preferred_runtime: COLONY_AGENT_RUNTIME_ID,
    provider: "openai-compat",
    model: "deepseek-v4-flash",
    env_vars: envVars,
  };
}
