/**
 * The per-agent fallback chain draft in the agent definition dialog.
 *
 * A hook rather than dialog state because `AgentDefinitionDialog` sits at the
 * file-size ratchet's limit, and because the seeding, the reset and the
 * "which chain is inherited" question are one concern: the agent's own chain
 * falls back to the global one, and the global one falls back to the relay's.
 */
import * as React from "react";

import type { PersonaModelOption } from "@/features/agents/ui/agentConfigOptions";
import type { ModelChainFieldProps } from "@/features/agents/ui/ModelChainField";
import { providerSupportsFallbackChain } from "@/features/agents/ui/modelChain.lib";
import { useRecommendedModelChain } from "@/features/agents/ui/useRecommendedModelChain";

export type AgentFallbackChainDraft = {
  /** Null inherits: the global chain if it has one, else the relay's. */
  value: string[] | null;
  /** Props for `ModelChainField`, spread straight into it. */
  fieldProps: ModelChainFieldProps;
  /** What an inheriting agent runs with, for the defaults summary row. */
  inherited: { entries: readonly string[]; source: "global" | "relay" };
  /** Back to inheriting, for the "Use agent defaults" switch and dialog close. */
  reset: () => void;
};

export function useAgentFallbackChain({
  disabled,
  globalChain,
  initialFallbackModels,
  open,
  options,
  optionsLoading,
  primaryModel,
  provider,
}: {
  disabled: boolean;
  /** The owner's global chain, which is what a per-agent null inherits. */
  globalChain: readonly string[];
  initialFallbackModels: string[] | null | undefined;
  open: boolean;
  options: readonly PersonaModelOption[] | null;
  optionsLoading: boolean;
  primaryModel: string;
  provider: string;
}): AgentFallbackChainDraft {
  const [value, setValue] = React.useState<string[] | null>(null);
  const providerSupportsChain = providerSupportsFallbackChain(provider);
  // Only ask the relay when the global chain would not answer the question
  // anyway, so a community with an authored global chain makes no IPC call.
  const relayChain = useRecommendedModelChain(
    providerSupportsChain && globalChain.length === 0,
  );

  // Seed on open, exactly like the dialog's other fields: the stored value is
  // the draft's starting point, and an absent one means this agent inherits.
  React.useEffect(() => {
    if (!open) return;
    setValue(initialFallbackModels ?? null);
  }, [initialFallbackModels, open]);

  const reset = React.useCallback(() => setValue(null), []);
  const inheritsGlobal = globalChain.length > 0;

  return {
    fieldProps: {
      disabled,
      onChange: setValue,
      options,
      optionsLoading,
      primaryModel,
      providerSupportsChain,
      recommended: inheritsGlobal ? [...globalChain] : relayChain,
      value,
    },
    inherited: {
      entries: inheritsGlobal ? globalChain : relayChain,
      source: inheritsGlobal ? "global" : "relay",
    },
    reset,
    value,
  };
}
