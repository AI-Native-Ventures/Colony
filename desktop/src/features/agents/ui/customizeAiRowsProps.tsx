/**
 * Assembles the props for {@link CustomizeAiRows} from the draft state of
 * `AgentDefinitionDialog`.
 *
 * It lives beside the rows rather than inside the dialog because the dialog
 * sits on the file-size ratchet, and because "what does this row inherit, and
 * what does Reset put back" is one concern that both the rows and the submit
 * path read.
 */
import type * as React from "react";

import type { CustomizeAiRowsProps } from "./CustomizeAiRows";
import type { CustomizeAiValues } from "./customizeAiRows.lib";
import type { EnvVarsValue } from "./EnvVarsEditor";
import type { AgentFallbackChainDraft } from "./useAgentFallbackChain";
import type { PersonaDropdownOption } from "./agentConfigOptions";
import {
  AUTO_PROVIDER_DROPDOWN_VALUE,
  getProviderApiKeyLabel,
  NO_RUNTIME_DROPDOWN_VALUE,
} from "./agentConfigOptions";
import { BUZZ_AGENT_THINKING_EFFORT } from "./buzzAgentConfig";
import type { PersonaModelField } from "./PersonaModelField";

export type CustomizeAiRowsInput = {
  /**
   * Harness catalog read state. When it is `"error"` the harness row renders
   * the retry notice instead of the warning, so a catalog that failed to load
   * stays recoverable from inside the Customize rows.
   */
  catalogStatus?: "loading" | "ready" | "error";
  apiKey: {
    inheritedLabel: string;
    isInherited: boolean;
    isRequired: boolean;
    /** The secret env key this provider needs, or null when it needs none. */
    secretEnvVar: string | null;
    value: string;
  };
  blankRuntimeOptionLabel: string;
  disabled: boolean;
  effectiveProvider: string;
  envVars: EnvVarsValue;
  fallbackChain: AgentFallbackChainDraft;
  inheritedEffort: string;
  inheritedModel: string;
  inheritedProvider: string;
  inheritedRuntimeId: string | undefined;
  isGlobalConfigLoading: boolean;
  model: string;
  modelField: Pick<
    React.ComponentProps<typeof PersonaModelField>,
    | "isExplicitModelRequired"
    | "modelDiscoveryStatus"
    | "modelDropdownOptions"
    | "modelSelectValue"
    | "showCustomModelInput"
    | "showSharedComputeAutoHint"
    | "transition"
  >;
  modelFieldVisible: boolean;
  onCustomModelChange: (value: string) => void;
  onCustomProviderIdChange: (value: string) => void;
  onEnvVarChange: (key: string, value: string) => void;
  onModelChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onRuntimeChange: (value: string) => void;
  provider: string;
  providerFieldVisible: boolean;
  providerOptions: readonly PersonaDropdownOption[];
  providerSelectValue: string;
  runtime: string;
  runtimeOptions: PersonaDropdownOption[];
  runtimeDropdownValue: string;
  runtimeSummaryLabel: string;
  runtimesLoading: boolean;
  runtimeWarning: React.ReactNode;
  showCustomProviderInput: boolean;
};

export function customizeAiValues(
  input: CustomizeAiRowsInput,
): CustomizeAiValues {
  return {
    fallbacks: { authored: input.fallbackChain.value !== null },
    harness: {
      current: input.runtime.trim(),
      inherited: input.inheritedRuntimeId ?? "",
    },
    model: { current: input.model.trim(), inherited: input.inheritedModel },
    provider: {
      current: input.provider.trim(),
      inherited: input.inheritedProvider,
      visible: input.providerFieldVisible,
    },
    reasoning: {
      current: input.envVars[BUZZ_AGENT_THINKING_EFFORT] ?? "",
      inherited: input.inheritedEffort,
    },
  };
}

export function buildCustomizeAiRowsProps(
  input: CustomizeAiRowsInput,
): CustomizeAiRowsProps {
  const values = customizeAiValues(input);
  const secretEnvVar = input.apiKey.secretEnvVar;
  return {
    disabled: input.disabled,
    fallbacks: {
      entries:
        input.fallbackChain.value ?? input.fallbackChain.inherited.entries,
      field: input.fallbackChain.fieldProps,
      onReset: input.fallbackChain.reset,
    },
    harness: {
      displayLabel: input.runtimeSummaryLabel,
      field: {
        catalogStatus: input.catalogStatus,
        disabled: input.disabled || input.runtimesLoading,
        onValueChange: input.onRuntimeChange,
        options: input.runtimeOptions,
        placeholder: input.blankRuntimeOptionLabel,
        value: input.runtimeDropdownValue,
        warning: input.runtimeWarning,
      },
      onReset: () =>
        input.onRuntimeChange(
          input.inheritedRuntimeId || NO_RUNTIME_DROPDOWN_VALUE,
        ),
    },
    loading: input.isGlobalConfigLoading,
    model: {
      field: {
        ...input.modelField,
        disabled: input.disabled,
        model: input.model,
        onCustomModelChange: input.onCustomModelChange,
        onModelValueChange: input.onModelChange,
      },
      onReset: () => input.onModelChange(input.inheritedModel),
      visible: input.modelFieldVisible,
    },
    provider: {
      apiKey: secretEnvVar
        ? {
            envVarName: secretEnvVar,
            inheritedLabel: input.apiKey.inheritedLabel,
            isInherited: input.apiKey.isInherited,
            isRequired: input.apiKey.isRequired,
            label: getProviderApiKeyLabel(input.effectiveProvider) ?? "API key",
            onValueChange: (next) => input.onEnvVarChange(secretEnvVar, next),
            value: input.apiKey.value,
          }
        : null,
      displayLabel:
        input.providerOptions.find(
          (option) => option.value === input.providerSelectValue,
        )?.label ||
        input.provider.trim() ||
        "Not configured",
      onChange: input.onProviderChange,
      onCustomIdChange: input.onCustomProviderIdChange,
      onReset: () =>
        input.onProviderChange(
          input.inheritedProvider || AUTO_PROVIDER_DROPDOWN_VALUE,
        ),
      options: input.providerOptions,
      selectValue: input.providerSelectValue,
      showCustomInput: input.showCustomProviderInput,
    },
    reasoning: {
      onChange: (next) =>
        input.onEnvVarChange(BUZZ_AGENT_THINKING_EFFORT, next),
      onReset: () => input.onEnvVarChange(BUZZ_AGENT_THINKING_EFFORT, ""),
    },
    values,
  };
}
