import { requiredCredentialEnvKeys } from "@/features/agents/ui/agentConfigOptions";
import { isColonyCreditsEligible } from "@/features/agents/ui/colonyCreditsEligibility";
import type {
  AcpRuntimeCatalogEntry,
  GlobalAgentConfig,
} from "@/shared/api/types";

export type AgentReadinessResult =
  | { ready: true; reason: "cli"; runtimeLabel: string }
  | { ready: true; reason: "buzz-agent" }
  | { ready: false };

/**
 * Determine whether the user has a working agent path configured.
 *
 * CLI path: the preferred Claude or Codex runtime is available and logged in.
 * Provider path: the preferred provider-configured runtime (Colony Agent,
 * Oh My Pi, OpenCode, or a custom harness) has provider and model set, plus
 * all required credential env vars for that provider.
 * Colony Credits path: the same runtime, provider and model, with the
 * credential coming from the relay instead of the local config.
 *
 * Returns enough info for the UI to say which path matched, or that neither did.
 */
export function resolveAgentReadiness(
  runtimes: readonly AcpRuntimeCatalogEntry[],
  globalConfig: GlobalAgentConfig,
  scope: "any" | "preferred" = "any",
): AgentReadinessResult {
  if (scope === "any") {
    for (const runtime of runtimes) {
      if (runtime.id === "buzz-agent") continue;
      if (
        runtime.availability === "available" &&
        (runtime.authStatus.status === "logged_in" ||
          runtime.authStatus.status === "not_applicable")
      ) {
        return { ready: true, reason: "cli", runtimeLabel: runtime.label };
      }
    }
  }

  const preferredRuntime =
    scope === "preferred"
      ? runtimes.find(
          (runtime) => runtime.id === globalConfig.preferred_runtime,
        )
      : runtimes.find((runtime) => runtime.id === "buzz-agent");
  if (preferredRuntime?.availability !== "available") {
    return { ready: false };
  }

  if (
    (preferredRuntime.id === "claude" || preferredRuntime.id === "codex") &&
    (preferredRuntime.authStatus.status === "logged_in" ||
      preferredRuntime.authStatus.status === "not_applicable")
  ) {
    return {
      ready: true,
      reason: "cli",
      runtimeLabel: preferredRuntime.label,
    };
  }

  if (
    preferredRuntime.id !== "buzz-agent" &&
    preferredRuntime.id !== "omp" &&
    preferredRuntime.id !== "opencode"
  ) {
    return { ready: false };
  }

  const provider = globalConfig.provider?.trim() ?? "";
  const model = globalConfig.model?.trim() ?? "";
  if (provider.length > 0 && model.length > 0) {
    // Colony Credits has no local credential to check, by design: the relay
    // mints a gateway lease at spawn and the desktop injects it as the
    // provider key (`managed_agents/runtime/provisioned.rs`). Demanding the
    // env var here made every hosted setup read as unconfigured, which is what
    // sent a brand-new owner to Settings for a key they are not meant to hold.
    // The eligibility matrix still applies: a pair the gateway cannot serve is
    // refused at spawn, so it must not report ready either.
    if (
      globalConfig.credential_mode === "colony_credits" &&
      isColonyCreditsEligible(preferredRuntime.id, provider)
    ) {
      return { ready: true, reason: "buzz-agent" };
    }
    const required = requiredCredentialEnvKeys(preferredRuntime.id, provider);
    const allKeysPresent = required.every(
      (key) => (globalConfig.env_vars[key] ?? "").trim().length > 0,
    );
    if (allKeysPresent) {
      return { ready: true, reason: "buzz-agent" };
    }
  }

  return { ready: false };
}
