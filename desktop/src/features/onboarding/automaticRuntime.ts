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

export function defaultColonyAgentConfig(
  current: GlobalAgentConfig = {
    credential_mode: "byok",
    env_vars: {},
    provider: null,
    model: null,
    preferred_runtime: null,
  },
): GlobalAgentConfig {
  return {
    ...current,
    credential_mode: "colony_credits",
    preferred_runtime: COLONY_AGENT_RUNTIME_ID,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    env_vars: {
      ...current.env_vars,
      OPENAI_COMPAT_BASE_URL: "https://api.deepseek.com",
    },
  };
}
