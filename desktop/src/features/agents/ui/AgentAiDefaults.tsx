import type * as React from "react";
import type { InheritedDefault } from "./bakedEnvHelpers";
import { getPersonaProviderOptions } from "./agentConfigOptions";
import { AiSettingRow } from "./aiSettingRow";
import { CUSTOMIZE_AI_ROW_LABELS } from "./customizeAiRows.lib";
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

export type AiDefaultsSummaryRow = {
  custom: boolean;
  label: string;
  testId: string;
  value: string;
};

/**
 * The rows the summary shows, in order.
 *
 * A row reads `custom` only where the thing being summarised carries its own
 * pin: the instance editor passes the agent's explicit provider or model, and
 * an agent-authored fallback chain is a pin of the same kind. Everything else
 * is inherited, which is the whole point of the tab this renders on.
 */
export function aiDefaultsSummaryRows({
  explicitModel,
  explicitProvider,
  fallbacks,
  harness,
  model,
  provider,
}: {
  explicitModel: string;
  explicitProvider: string;
  fallbacks?: {
    entries: readonly string[];
    source: "agent" | "global" | "relay";
  };
  harness?: string;
  model: string;
  provider: string;
}): AiDefaultsSummaryRow[] {
  return [
    ...(harness !== undefined
      ? [
          {
            custom: false,
            label: CUSTOMIZE_AI_ROW_LABELS.harness,
            testId: "agent-ai-defaults-harness",
            value: harness || "Not configured",
          },
        ]
      : []),
    {
      custom: explicitProvider.trim().length > 0,
      label: CUSTOMIZE_AI_ROW_LABELS.provider,
      testId: "agent-ai-defaults-provider",
      value: provider ? providerLabel(provider) : "Not configured",
    },
    {
      custom: explicitModel.trim().length > 0,
      label: CUSTOMIZE_AI_ROW_LABELS.model,
      testId: "agent-ai-defaults-model",
      value: model || "Not configured",
    },
    ...(fallbacks
      ? [
          {
            custom: fallbacks.source === "agent",
            label: CUSTOMIZE_AI_ROW_LABELS.fallbacks,
            testId: "agent-ai-defaults-fallbacks",
            value: formatFallbacksSummary(fallbacks),
          },
        ]
      : []),
  ];
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

  // The same rows as the Customize tab, read-only: no Change, no Reset. A row
  // reads custom only where this agent carries its own pin; everything else
  // is what it inherits from the agent defaults.
  return (
    <div className="space-y-1" data-testid="agent-ai-defaults-notice">
      <div>
        {aiDefaultsSummaryRows({
          explicitModel,
          explicitProvider,
          fallbacks,
          harness,
          model,
          provider,
        }).map((row) => (
          <AiSettingRow
            custom={row.custom}
            key={row.testId}
            label={row.label}
            testId={row.testId}
            value={row.value}
          />
        ))}
      </div>
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
