/**
 * The fallback chain row of the global agent defaults.
 *
 * Owns the two things `ModelChainField` deliberately does not: where Colony's
 * recommended chain comes from (the active community's relay), and how the
 * stored config spells "use it" (an empty `fallback_models`, which the field
 * shows as `null`).
 */
import { AiSourcePill } from "@/features/agents/ui/aiSettingRow";
import { ModelChainField } from "@/features/agents/ui/ModelChainField";
import type { PersonaModelOption } from "@/features/agents/ui/agentConfigOptions";
import { providerSupportsFallbackChain } from "@/features/agents/ui/modelChain.lib";
import { useRecommendedModelChain } from "@/features/agents/ui/useRecommendedModelChain";
import type { GlobalAgentConfig } from "@/shared/api/types";

const PILL_TEST_ID = "global-fallback-chain-pill";

export function GlobalFallbackChainField({
  config,
  disabled,
  discoveredModelOptions,
  modelDiscoveryLoading,
  onConfigChange,
  provider,
  showSourcePill = false,
}: {
  config: GlobalAgentConfig;
  disabled: boolean;
  discoveredModelOptions: readonly PersonaModelOption[] | null;
  modelDiscoveryLoading: boolean;
  onConfigChange: (next: GlobalAgentConfig) => void;
  provider: string;
  /** Show the agent dialog's inherited/custom pill beside the label. */
  showSourcePill?: boolean;
}) {
  const providerSupportsChain = providerSupportsFallbackChain(provider);
  const recommended = useRecommendedModelChain(providerSupportsChain);
  const authored = config.fallback_models ?? [];

  return (
    <ModelChainField
      disabled={disabled}
      labelAccessory={
        showSourcePill ? (
          <AiSourcePill custom={authored.length > 0} testId={PILL_TEST_ID} />
        ) : undefined
      }
      onChange={(next) =>
        onConfigChange({ ...config, fallback_models: next ?? [] })
      }
      options={discoveredModelOptions}
      optionsLoading={modelDiscoveryLoading}
      primaryModel={config.model ?? ""}
      providerSupportsChain={providerSupportsChain}
      recommended={recommended}
      value={authored.length === 0 ? null : authored}
    />
  );
}
