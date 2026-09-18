/**
 * The models an agent is tried against, in order, as the Activity pane needs
 * them: the configured model first, then the fallbacks it would actually run.
 *
 * Same resolution the dialogs use, one layer up: the owner's global chain when
 * they authored one, Colony's recommended chain otherwise.
 */
import { useGlobalAgentConfig } from "../useGlobalAgentConfig";
import { effectiveModelChain } from "./agentTurnModelNote";
import { useRecommendedModelChain } from "./useRecommendedModelChain";

export function useEffectiveModelChain(): string[] {
  const { globalConfig } = useGlobalAgentConfig();
  const globalChain = globalConfig.fallback_models ?? [];
  const relayChain = useRecommendedModelChain(globalChain.length === 0);
  return effectiveModelChain(
    globalConfig.model ?? "",
    globalChain.length > 0 ? globalChain : relayChain,
  );
}
