import type * as React from "react";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import type { AgentAiConfigurationMode } from "./agentAiConfigurationPolicy";
import { AgentAiDefaultsNotice } from "./AgentAiDefaults";
import { AiSettingRow } from "./aiSettingRow";
import { CUSTOMIZE_AI_ROW_LABELS } from "./customizeAiRows.lib";
import type { InheritedDefault } from "./bakedEnvHelpers";

export type { AgentAiConfigurationMode } from "./agentAiConfigurationPolicy";

export function HarnessModelDefaultNotice({
  harness,
  model,
}: {
  harness: string;
  model?: string | null;
}) {
  // Same rows as the Customize tab, so the two tabs of one dialog do not read
  // as two different products. This harness drives its own provider, so the
  // summary is the harness and the model it runs.
  return (
    <div data-testid="agent-harness-defaults-notice">
      <AiSettingRow
        custom={false}
        label={CUSTOMIZE_AI_ROW_LABELS.harness}
        testId="agent-harness-defaults-harness"
        value={harness || "Not configured"}
      />
      <AiSettingRow
        custom={false}
        label={CUSTOMIZE_AI_ROW_LABELS.model}
        testId="agent-harness-defaults-model"
        value={model?.trim() || "Harness default"}
      />
    </div>
  );
}

export function AgentCreateAiDefaultsSummary({
  canChooseProvider,
  fallbacks,
  harness,
  inheritedModel,
  inheritedProvider,
  isConfigured,
  model,
  onEditDefaults,
  triggerRef,
}: {
  canChooseProvider: boolean;
  fallbacks?: {
    entries: readonly string[];
    source: "agent" | "global" | "relay";
  };
  harness: string;
  inheritedModel: InheritedDefault;
  inheritedProvider: InheritedDefault;
  isConfigured: boolean;
  model?: string | null;
  onEditDefaults: () => void;
  triggerRef?: React.Ref<HTMLButtonElement>;
}) {
  return canChooseProvider ? (
    <AgentAiDefaultsNotice
      isConfigured={isConfigured}
      onEditDefaults={onEditDefaults}
      triggerRef={triggerRef}
      explicitModel=""
      explicitProvider=""
      fallbacks={fallbacks}
      harness={harness}
      inheritedModel={inheritedModel}
      inheritedProvider={inheritedProvider}
    />
  ) : (
    <HarnessModelDefaultNotice harness={harness} model={model} />
  );
}

export function AgentAiConfigurationModeField({
  mode,
  onModeChange,
}: {
  mode: AgentAiConfigurationMode;
  onModeChange: (mode: AgentAiConfigurationMode) => void;
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium text-foreground">AI configuration</p>
      <Tabs
        onValueChange={(value) =>
          onModeChange(value as AgentAiConfigurationMode)
        }
        value={mode}
      >
        <TabsList className="relative isolate grid h-9 w-full grid-cols-2 overflow-hidden rounded-lg bg-muted p-0.5">
          <div
            aria-hidden="true"
            className="absolute bottom-0.5 left-0.5 top-0.5 z-0 rounded-md bg-background shadow-sm transition-transform duration-[250ms] ease-out"
            style={{
              transform: `translateX(${mode === "custom" ? 100 : 0}%)`,
              width: "calc((100% - 4px) / 2)",
            }}
          />
          <TabsTrigger
            className="relative z-10 h-full rounded-md bg-transparent text-xs font-medium shadow-none transition-colors data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            value="defaults"
          >
            Use agent defaults
          </TabsTrigger>
          <TabsTrigger
            className="relative z-10 h-full rounded-md bg-transparent text-xs font-medium shadow-none transition-colors data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            value="custom"
          >
            Customize for this agent
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </div>
  );
}
