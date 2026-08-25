import type { EnvVarsValue } from "./EnvVarsEditor";
import {
  AUTO_MODEL_DROPDOWN_VALUE,
  type PersonaDropdownOption,
  type PersonaModelOption,
  AUTO_PROVIDER_DROPDOWN_VALUE,
  CUSTOM_MODEL_DROPDOWN_VALUE,
  CUSTOM_PROVIDER_DROPDOWN_VALUE,
  getProviderApiKeyEnvVar,
  shouldClearKnownModelForSelectionScope,
} from "./agentConfigOptions";
import { shouldClearModelForRuntimeChange } from "./personaRuntimeModel";
import { modelDropdownOptions } from "./relayMeshModelPicker";
import { MODEL_DISCOVERY_LOADING_VALUE } from "./usePersonaModelDiscovery";
import {
  envVarsClearingManagedApiKey,
  envVarsWithoutKey,
} from "./providerEnvVarUpdates";

/**
 * Pure transition functions for the runtime -> LLM provider -> model dropdown
 * state machine shared by the persona / create-agent / edit-agent dialogs.
 * Each dialog applies the returned state to its own setters and layers its
 * dialog-specific side effects (inherit pins, command sync, catalog memory)
 * at the call site. Divergent behaviors are parameterized, never merged.
 */
export type RuntimeModelProviderSelection = {
  provider: string;
  model: string;
  isCustomProviderEditing: boolean;
  isCustomModelEditing: boolean;
  envVars: EnvVarsValue;
};

export function selectionOnRuntimeChange(
  current: RuntimeModelProviderSelection,
  params: {
    previousRuntime: string;
    nextRuntime: string;
    /** Caller-computed: whether the next runtime supports provider selection. */
    nextRuntimeCanChooseProvider: boolean;
    /**
     * Persona/Edit clear the managed API key and custom-model editing flag
     * when switching to a provider-locked runtime ("full"); Create clears
     * only the provider selection ("provider-only").
     */
    lockedRuntimeReset: "full" | "provider-only";
  },
): RuntimeModelProviderSelection {
  const next = { ...current };

  if (
    shouldClearModelForRuntimeChange(
      params.previousRuntime,
      params.nextRuntime,
    ) ||
    shouldClearKnownModelForSelectionScope({
      model: current.model,
      provider: current.provider,
      runtime: params.nextRuntime,
    })
  ) {
    next.model = "";
    next.isCustomModelEditing = false;
  }

  if (!params.nextRuntimeCanChooseProvider) {
    if (params.lockedRuntimeReset === "full") {
      next.envVars = envVarsClearingManagedApiKey(
        next.envVars,
        current.provider,
        "",
      );
      next.isCustomModelEditing = false;
    }
    next.isCustomProviderEditing = false;
    next.provider = "";
  }

  return next;
}

export function selectionOnProviderDropdownChange(
  current: RuntimeModelProviderSelection,
  params: {
    /** Runtime id used for the model-scope clearing rule. */
    runtime: string;
    nextValue: string;
    /**
     * Persona-only: clear the model when the newly selected provider's API
     * key is not yet filled (model discovery cannot run without it).
     */
    clearModelWhenApiKeyMissing: boolean;
  },
): RuntimeModelProviderSelection {
  const next = { ...current };

  if (params.nextValue === CUSTOM_PROVIDER_DROPDOWN_VALUE) {
    const previousEnvVar = getProviderApiKeyEnvVar(current.provider);
    if (previousEnvVar) {
      next.envVars = envVarsWithoutKey(next.envVars, previousEnvVar);
    }
    next.isCustomProviderEditing = true;
    next.provider = "";
    return next;
  }

  const nextProvider =
    params.nextValue === AUTO_PROVIDER_DROPDOWN_VALUE ? "" : params.nextValue;
  next.envVars = envVarsClearingManagedApiKey(
    next.envVars,
    current.provider,
    nextProvider,
  );
  next.isCustomProviderEditing = false;
  next.provider = nextProvider;

  if (params.clearModelWhenApiKeyMissing) {
    const requiredEnvVar = getProviderApiKeyEnvVar(nextProvider);
    if (requiredEnvVar && !next.envVars[requiredEnvVar]?.trim()) {
      next.model = "";
      next.isCustomModelEditing = false;
    }
  }

  // Guard on the PRE-transition editing flag, matching all three dialogs
  // (their handlers read the render-scope value).
  if (
    !current.isCustomModelEditing &&
    shouldClearKnownModelForSelectionScope({
      model: current.model,
      provider: nextProvider,
      runtime: params.runtime,
    })
  ) {
    next.model = "";
    next.isCustomModelEditing = false;
  }

  return next;
}

export function selectionOnModelDropdownChange(
  current: RuntimeModelProviderSelection,
  params: {
    nextValue: string;
    /**
     * Persona clears a known (non-custom) model when entering custom mode;
     * Create/Edit keep it as the editable starting value.
     */
    clearKnownModelOnCustomEntry: boolean;
    /** Caller-computed: whether the current model is outside the known options. */
    isModelCustom: boolean;
  },
): RuntimeModelProviderSelection {
  const next = { ...current };

  if (params.nextValue === CUSTOM_MODEL_DROPDOWN_VALUE) {
    next.isCustomModelEditing = true;
    if (params.clearKnownModelOnCustomEntry && !params.isModelCustom) {
      next.model = "";
    }
    return next;
  }

  next.isCustomModelEditing = false;
  next.model =
    params.nextValue === AUTO_MODEL_DROPDOWN_VALUE ? "" : params.nextValue;
  return next;
}

// ── Dropdown option builders (extracted from AgentDefinitionDialog, size guard) ──

/**
 * Provider dropdown options for the definition dialog: the provider list with
 * blank ids dropped, plus the trailing Custom entry.
 */
export function buildProviderDropdownOptions<
  T extends { id: string; label: string },
>(providerOptions: readonly T[]): PersonaDropdownOption[] {
  return [
    ...providerOptions
      .filter((option) => option.id.trim().length > 0)
      .map((option) => ({
        label: option.label,
        value: option.id,
      })),
    { label: "Custom provider...", value: CUSTOM_PROVIDER_DROPDOWN_VALUE },
  ];
}

/**
 * Model dropdown options for a relay-mesh-aware scope: discovery/loading
 * states via the shared builder, then scope filtering — relay-mesh keeps its
 * Automatic entry (relabeled), every other scope drops it.
 */
export function buildModelDropdownOptionsForScope(
  isRelayMesh: boolean,
  discoveryLoading: boolean,
  options: readonly PersonaModelOption[],
): PersonaDropdownOption[] {
  return modelDropdownOptions({
    allowCustom: !isRelayMesh,
    globalModel: undefined,
    loading: discoveryLoading,
    loadingValue: MODEL_DISCOVERY_LOADING_VALUE,
    options,
  })
    .filter(
      (option) => isRelayMesh || option.value !== AUTO_MODEL_DROPDOWN_VALUE,
    )
    .map((option) =>
      isRelayMesh && option.value === AUTO_MODEL_DROPDOWN_VALUE
        ? { ...option, label: "Automatic" }
        : option,
    );
}
