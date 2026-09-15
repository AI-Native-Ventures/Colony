/**
 * The fallback chain row of the global agent defaults.
 *
 * Owns the two things `ModelChainField` deliberately does not: where Colony's
 * recommended chain comes from (the active community's relay), and how the
 * stored config spells "use it" (an empty `fallback_models`, which the field
 * shows as `null`).
 */
import { useQuery } from "@tanstack/react-query";

import { useCommunities } from "@/features/communities/useCommunities";
import { ModelChainField } from "@/features/agents/ui/ModelChainField";
import type { PersonaModelOption } from "@/features/agents/ui/agentConfigOptions";
import { getRecommendedModelChain } from "@/shared/api/tauriGlobalAgentConfig";
import type { GlobalAgentConfig } from "@/shared/api/types";

/** Only OpenRouter routes a `models[]` array, so only it can have a chain. */
const CHAIN_PROVIDER_ID = "openrouter";

/**
 * A cold cache answers `[]` and schedules its own refresh, so ask again a few
 * seconds later rather than showing an owner "no chain" for a community that
 * has one.
 */
const RECOMMENDED_CHAIN_RETRY_MS = 3000;

export function GlobalFallbackChainField({
  config,
  disabled,
  discoveredModelOptions,
  modelDiscoveryLoading,
  onConfigChange,
  provider,
}: {
  config: GlobalAgentConfig;
  disabled: boolean;
  discoveredModelOptions: readonly PersonaModelOption[] | null;
  modelDiscoveryLoading: boolean;
  onConfigChange: (next: GlobalAgentConfig) => void;
  provider: string;
}) {
  const { activeCommunity } = useCommunities();
  const relayUrl = activeCommunity?.relayUrl ?? "";
  const providerSupportsChain =
    provider.trim().toLowerCase() === CHAIN_PROVIDER_ID;
  const recommendedQuery = useQuery({
    enabled: providerSupportsChain && relayUrl.length > 0,
    queryFn: () => getRecommendedModelChain(relayUrl),
    queryKey: ["recommendedModelChain", relayUrl],
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) === 0
        ? RECOMMENDED_CHAIN_RETRY_MS
        : false,
  });
  const authored = config.fallback_models ?? [];

  return (
    <ModelChainField
      disabled={disabled}
      onChange={(next) =>
        onConfigChange({ ...config, fallback_models: next ?? [] })
      }
      options={discoveredModelOptions}
      optionsLoading={modelDiscoveryLoading}
      primaryModel={config.model ?? ""}
      providerSupportsChain={providerSupportsChain}
      recommended={recommendedQuery.data ?? []}
      value={authored.length === 0 ? null : authored}
    />
  );
}
