import type { GlobalAgentConfig } from "@/shared/api/types";

/**
 * Phase 1 Colony Credits eligibility shared by the settings handle. Keep the
 * runtime/provider matrix identical to the Tauri preflight: Codex is
 * OpenAI-compatible by construction; Goose and Buzz Agent require an
 * OpenAI-compatible provider; subscription/custom runtimes stay BYOK.
 */
export function isColonyCreditsEligible(
  runtimeId: string,
  provider: string | null | undefined,
): boolean {
  if (runtimeId === "codex") return true;
  if (runtimeId !== "goose" && runtimeId !== "buzz-agent") return false;
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-compat";
}

/**
 * Env var that overrides the normalized `provider` field for the given
 * runtime, ahead of `GlobalAgentConfig.provider` — mirrors the resolution
 * order the backend readiness check and `ColonyCreditsCredentialChoice` both
 * use. Exported so every caller computing "effective provider" agrees with
 * this module.
 */
export function colonyCreditsProviderEnvVar(runtimeId: string): string {
  return runtimeId === "goose" ? "GOOSE_PROVIDER" : "BUZZ_AGENT_PROVIDER";
}

/**
 * The provider Colony Credits eligibility should actually be judged against:
 * the runtime's provider env var override when present, else the normalized
 * `provider` field. Single source of truth for both the credential-choice UI
 * and the revalidation gate below, so they can never drift.
 */
export function resolveEffectiveProviderForColonyCredits(
  runtimeId: string,
  provider: string | null | undefined,
  envVars: Record<string, string>,
): string | null | undefined {
  return envVars[colonyCreditsProviderEnvVar(runtimeId)] ?? provider;
}

/**
 * User-facing reason Colony Credits is unavailable for a runtime, shared by
 * the credential-choice UI (disabled-option copy) and the revalidation
 * notice (what changed and why) so the wording never drifts between them.
 */
export function getColonyCreditsUnavailableReason(runtimeId: string): string {
  if (runtimeId === "claude") {
    return "Unavailable for Claude/Anthropic subscription agents.";
  }
  if (runtimeId === "goose" || runtimeId === "buzz-agent") {
    return "Select an OpenAI or OpenAI-compatible provider first.";
  }
  return "Unavailable for this harness.";
}

export type ColonyCreditsRevalidationResult = {
  config: GlobalAgentConfig;
  /** Non-null only when `credential_mode` was downgraded to `byok` — the
   *  reason to surface to the user. Null means the config was already valid
   *  and passed through unchanged. */
  downgradeReason: string | null;
};

/**
 * Revalidates `credential_mode` against the config's runtime + effective
 * provider. Colony Credits can only ever be selected while eligible (see
 * `ColonyCreditsCredentialChoice`), but nothing previously re-checked that
 * pairing after the fact — a later harness, provider, or provider-env-var
 * change could leave `credential_mode: "colony_credits"` pointed at a
 * runtime/provider pair the backend refuses at agent-spawn time, with no way
 * back into the UI that caused it.
 *
 * This is the single revalidation gate every writer of `provider`,
 * `credential_mode`, `preferred_runtime`, or the provider env var override
 * must funnel through — see `AgentDefaultsEditor.handleConfigChange` (every
 * draft edit) and `performSave` (the final gate before persisting).
 *
 * Never silently mutates credential_mode without reporting it: a downgrade
 * always comes back with a non-null `downgradeReason` so the caller can
 * surface what changed and why.
 */
export function revalidateColonyCreditsCredentialMode(
  config: GlobalAgentConfig,
): ColonyCreditsRevalidationResult {
  if (config.credential_mode !== "colony_credits") {
    return { config, downgradeReason: null };
  }
  const runtimeId = config.preferred_runtime ?? "";
  const effectiveProvider = resolveEffectiveProviderForColonyCredits(
    runtimeId,
    config.provider,
    config.env_vars,
  );
  if (isColonyCreditsEligible(runtimeId, effectiveProvider)) {
    return { config, downgradeReason: null };
  }
  return {
    config: { ...config, credential_mode: "byok" },
    downgradeReason: getColonyCreditsUnavailableReason(runtimeId),
  };
}
