export type AgentAiConfigurationMode = "defaults" | "custom";

export type AgentAiConfigurationPair = {
  provider: string;
  model: string;
};

/**
 * The full set of AI-configuration fields the mode toggle owns: harness
 * (runtime id) plus the provider/model pair. Effort travels in the env-var
 * draft and is cleared by the caller using the runtime catalog's
 * `thinkingEnvVar` facts, not here.
 */
export type AgentAiConfigurationState = AgentAiConfigurationPair & {
  runtime: string;
};

export function initialAgentAiConfigurationMode(
  state: Partial<AgentAiConfigurationState>,
): AgentAiConfigurationMode {
  return state.provider?.trim() || state.model?.trim() || state.runtime?.trim()
    ? "custom"
    : "defaults";
}

export function agentAiConfigurationPairForMode({
  current,
  inherited,
  mode,
  needsProviderSelection = true,
}: {
  current: AgentAiConfigurationPair;
  inherited: AgentAiConfigurationPair;
  mode: AgentAiConfigurationMode;
  needsProviderSelection?: boolean;
}): AgentAiConfigurationPair {
  if (mode === "defaults") {
    return { provider: "", model: "" };
  }

  return {
    provider: needsProviderSelection
      ? current.provider.trim() || inherited.provider
      : "",
    model: current.model.trim() || inherited.model,
  };
}

/**
 * The one toggle owns harness + provider + model (+ effort, via the env-var
 * draft) TOGETHER. "Use agent defaults" clears all four so the agent follows
 * the global defaults; "Customize for this agent" pins all four.
 *
 * `inheritedRuntimeId` seeds the harness picker when entering Customize with
 * no explicit pin yet, mirroring how the provider/model pair seeds from the
 * inherited values.
 */
export function agentAiConfigurationStateForMode({
  current,
  inherited,
  mode,
  needsProviderSelection = true,
}: {
  current: AgentAiConfigurationState;
  inherited: AgentAiConfigurationPair & { runtimeId?: string | null };
  mode: AgentAiConfigurationMode;
  needsProviderSelection?: boolean;
}): AgentAiConfigurationState {
  if (mode === "defaults") {
    return { runtime: "", provider: "", model: "" };
  }

  return {
    runtime: current.runtime.trim() || inherited.runtimeId || "",
    provider: needsProviderSelection
      ? current.provider.trim() || inherited.provider
      : "",
    model: current.model.trim() || inherited.model,
  };
}

/**
 * Whether a Customize (explicit) AI pair is complete enough to submit.
 *
 * `needsProviderSelection` reflects whether the provider picker is actually
 * shown to the user: Colony Agent / Goose expose it (and runtime-less legacy /
 * builtin definitions do too), so both provider and model are required, while
 * Codex / Claude drive their own provider and hide the field, so requiring a
 * provider there would gate Save on a value the user can never set (the
 * create/edit "Save stays disabled" regression). Callers should pass the
 * field-visibility capability (`runtimeCanChooseLlmProvider`), not the raw
 * runtime capability, so the gate never diverges from the visible picker. It
 * defaults to `true` so existing callers keep the provider+model requirement.
 */
export function agentAiConfigurationModeSatisfied(
  mode: AgentAiConfigurationMode,
  pair: AgentAiConfigurationPair,
  needsProviderSelection = true,
) {
  if (mode === "defaults") {
    return true;
  }
  const providerOk = !needsProviderSelection || pair.provider.trim().length > 0;
  return providerOk && pair.model.trim().length > 0;
}
