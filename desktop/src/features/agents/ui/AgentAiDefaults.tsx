import type * as React from "react";
import type { InheritedDefault } from "./bakedEnvHelpers";
import { getPersonaProviderOptions } from "./agentConfigOptions";
import { ModelEnvOverrideNotice } from "./ModelEnvOverrideNotice";
import { Button } from "@/shared/ui/button";

function providerLabel(providerId: string) {
  const option = getPersonaProviderOptions("", "buzz-agent").find(
    (candidate) => candidate.id === providerId,
  );
  return option?.label ?? providerId;
}

export function formatAiDefaultsSummary({
  provider,
  model,
}: {
  provider: InheritedDefault;
  model: InheritedDefault;
}) {
  const parts = [
    provider.value ? providerLabel(provider.value) : null,
    model.value || null,
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join(" · ") : "Not configured";
}

/**
 * The Fallbacks row's text.
 *
 * An empty chain is a decision ("this agent stops at its model"), not a
 * missing value, so it reads as None. A chain that came from the relay is
 * labelled, because the owner did not choose those ids and the list can change
 * under them when the relay reranks.
 */
export function formatFallbacksSummary({
  entries,
  source,
}: {
  entries: readonly string[];
  source: "agent" | "global" | "relay";
}): string {
  if (entries.length === 0) return "None";
  const joined = entries.join(", ");
  return source === "relay" ? `${joined} (Colony recommended)` : joined;
}

export function AgentAiDefaultsNotice({
  isConfigured = true,
  onEditDefaults,
  triggerRef,
  explicitModel,
  explicitProvider,
  envVars,
  fallbacks,
  harness,
  inheritedModel,
  inheritedProvider,
}: {
  isConfigured?: boolean;
  onEditDefaults: () => void;
  triggerRef?: React.Ref<HTMLButtonElement>;
  explicitModel: string;
  explicitProvider: string;
  /**
   * The env vars saved on whatever this notice summarises. Only used to warn
   * about a saved `BUZZ_ACP_MODEL`/`BUZZ_ACP_PROVIDER`, which the resolved
   * configuration overrides. See {@link ModelEnvOverrideNotice}.
   */
  envVars?: Record<string, string> | null;
  /** The chain this agent actually runs with, and where it came from. */
  fallbacks?: {
    entries: readonly string[];
    source: "agent" | "global" | "relay";
  };
  harness?: string;
  inheritedModel: InheritedDefault;
  inheritedProvider: InheritedDefault;
}) {
  const provider = explicitProvider.trim() || inheritedProvider.value;
  const model = explicitModel.trim() || inheritedModel.value;

  if (!isConfigured) {
    return (
      <div
        className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5"
        data-testid="agent-ai-defaults-notice"
      >
        <p className="text-sm font-medium text-foreground">
          Global defaults not set
        </p>
        <Button
          className="shrink-0"
          data-testid="set-ai-defaults"
          onClick={onEditDefaults}
          ref={triggerRef}
          size="sm"
          type="button"
          variant="outline"
        >
          Set
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1" data-testid="agent-ai-defaults-notice">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 text-sm">
        {harness !== undefined ? (
          <>
            <dt className="text-muted-foreground">Harness</dt>
            <dd className="truncate text-foreground">
              {harness || "Not configured"}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Provider</dt>
        <dd className="truncate text-foreground">
          {provider ? providerLabel(provider) : "Not configured"}
        </dd>
        <dt className="text-muted-foreground">Model</dt>
        <dd className="truncate text-foreground">
          {model || "Not configured"}
        </dd>
        {fallbacks ? (
          <>
            <dt className="text-muted-foreground">Fallbacks</dt>
            <dd
              className="truncate text-foreground"
              data-testid="agent-ai-defaults-fallbacks"
            >
              {formatFallbacksSummary(fallbacks)}
            </dd>
          </>
        ) : null}
      </dl>
      <ModelEnvOverrideNotice envVars={envVars} />
      <Button
        className="h-auto px-0 py-1"
        data-testid="edit-ai-defaults"
        onClick={onEditDefaults}
        ref={triggerRef}
        size="xs"
        type="button"
        variant="link"
      >
        Edit global defaults
      </Button>
    </div>
  );
}
