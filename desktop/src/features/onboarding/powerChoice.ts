import type { GlobalAgentConfig } from "@/shared/api/types";
import { defaultColonyAgentConfig } from "./automaticRuntime";

/** Owner-facing payment choices, independent of installed runtime names. */
export type PowerLane = "subscription" | "colony" | "openrouter" | "existing";

/** Preserve an existing choice; discovery never chooses a personal subscription. */
export function powerLaneForConfig(config: GlobalAgentConfig): PowerLane {
  if (config.credential_mode === "colony_credits") return "colony";
  if (config.provider === "openrouter")
    return isFreeOpenRouterModel(config.model) ? "openrouter" : "existing";
  return config.preferred_runtime && config.preferred_runtime !== "buzz-agent"
    ? "subscription"
    : config.provider
      ? "existing"
      : "colony";
}

/** A free route never inherits a paid model or an alternate model chain. */
export function isFreeOpenRouterModel(model: string | null): boolean {
  return model === "openrouter/free" || !!model?.endsWith(":free");
}

/** Existing provider choices stay intact even when they inherit the default runtime. */
export function initialPowerConfig(
  current: GlobalAgentConfig,
): GlobalAgentConfig {
  return current.preferred_runtime || current.provider
    ? current
    : configForPowerLane(current, powerLaneForConfig(current));
}

/** Build an explicit lane change without exposing secrets to onboarding storage. */
export function configForPowerLane(
  current: GlobalAgentConfig,
  lane: PowerLane,
  runtimeId?: string,
): GlobalAgentConfig {
  if (lane === "existing") return current;
  if (lane === "colony") return defaultColonyAgentConfig(current);
  if (lane === "subscription")
    return {
      ...current,
      credential_mode: "byok",
      preferred_runtime: runtimeId ?? null,
      provider: null,
      model: null,
    };
  const envVars = { ...current.env_vars };
  delete envVars.BUZZ_AGENT_MODEL;
  delete envVars.BUZZ_AGENT_PROVIDER;
  delete envVars.OPENROUTER_BASE_URL;
  return {
    ...current,
    credential_mode: "byok",
    preferred_runtime: "buzz-agent",
    provider: "openrouter",
    model: isFreeOpenRouterModel(current.model)
      ? current.model
      : "openrouter/free",
    env_vars: envVars,
  };
}
