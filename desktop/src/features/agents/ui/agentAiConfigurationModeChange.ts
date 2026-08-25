import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";

import type { EnvVarsValue } from "./EnvVarsEditor";
import type { AgentAiConfigurationMode } from "./agentAiConfigurationPolicy";
import { agentAiConfigurationStateForMode } from "./agentAiConfigurationPolicy";

type ModeChangeInput = {
  mode: AgentAiConfigurationMode;
  runtime: string;
  provider: string;
  model: string;
  envVars: EnvVarsValue;
  runtimes: Pick<AcpRuntimeCatalogEntry, "thinkingEnvVar">[];
  inheritedProvider: string;
  inheritedModel: string;
  /** Model advertised by the selected harness's own config file, if any. */
  fileModel?: string | null;
  inheritedRuntimeId?: string | null;
  needsProviderSelection: boolean;
};

/**
 * Pure core of the AI-configuration mode toggle in `AgentDefinitionDialog`.
 *
 * The toggle owns harness + provider + model + effort together at the
 * persistence level (a defaults submission omits the pins — see
 * `buildRuntimeModelProviderPayload`'s `isDefaultsMode`), while the harness
 * draft is kept so gates evaluate what inheritance would actually run.
 *
 * Switching to defaults also strips every catalog-declared thinking-effort
 * env key from the draft: a pin left behind under any known effort key would
 * silently override the global defaults after the agent stops being
 * customized. The keys come from the runtime catalog's capability facts,
 * never hardcoded ids.
 */
export function applyAgentAiConfigurationModeChange(input: ModeChangeInput): {
  runtime: string;
  provider: string;
  model: string;
  envVars: EnvVarsValue;
} {
  const nextState = agentAiConfigurationStateForMode({
    current: {
      runtime: input.runtime,
      provider: input.provider,
      model: input.model,
    },
    inherited: input.needsProviderSelection
      ? {
          provider: input.inheritedProvider,
          model: input.inheritedModel,
          runtimeId: input.inheritedRuntimeId,
        }
      : {
          provider: "",
          model: input.fileModel?.trim() ?? "",
          runtimeId: input.inheritedRuntimeId,
        },
    mode: input.mode,
    needsProviderSelection: input.needsProviderSelection,
  });

  let envVars = input.envVars;
  if (input.mode === "defaults") {
    // The toggle owns effort too. Effort values persist under each harness's
    // thinking env key (a runtime-catalog capability fact).
    const effortEnvKeys = new Set(
      input.runtimes
        .map((entry) => entry.thinkingEnvVar?.trim())
        .filter((key): key is string => Boolean(key)),
    );
    if (effortEnvKeys.size > 0) {
      envVars = Object.fromEntries(
        Object.entries(envVars).filter(([key]) => !effortEnvKeys.has(key)),
      );
    }
  }

  return {
    runtime: nextState.runtime,
    provider: nextState.provider,
    model: nextState.model,
    envVars,
  };
}
