/**
 * The Customize tab of `AgentDefinitionDialog`, as one row per setting.
 *
 * Every row states the value the agent will run with, whether that value is
 * inherited from the agent defaults or set here, and offers the existing
 * picker inline behind Change. Nothing is an empty required field: a row the
 * user never touched shows what it inherits, so opening the tab cannot put the
 * dialog in a state the owner has to repair before saving.
 *
 * The rules live in `customizeAiRows.lib.ts`; this file is presentation and
 * the per-row disclosure state.
 */
import * as React from "react";

import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { AgentHarnessField } from "./AgentHarnessField";
import {
  type PersonaDropdownOption,
  PERSONA_FIELD_CONTROL_CLASS,
  PERSONA_FIELD_SHELL_CLASS,
} from "./agentConfigOptions";
import { EffortSelectField } from "./buzzAgentModelTuningFields";
import { getProviderEffortConfig } from "./buzzAgentConfig";
import { ModelChainField } from "./ModelChainField";
import { PersonaDropdownField } from "./PersonaDropdownField";
import { PersonaModelField } from "./PersonaModelField";
import { PersonaProviderApiKeyField } from "./PersonaProviderApiKeyField";
import {
  CUSTOMIZE_AI_ROW_LABELS,
  type CustomizeAiRowId,
  type CustomizeAiValues,
  customizeAiRowCustomFlags,
  providerKeyNote,
  rowDisplayValue,
} from "./customizeAiRows.lib";

type ApiKeyProps = {
  envVarName: string;
  inheritedLabel: string;
  isInherited: boolean;
  isRequired: boolean;
  label: string;
  onValueChange: (value: string) => void;
  value: string;
};

export type CustomizeAiRowsProps = {
  disabled: boolean;
  /** Agent defaults have not resolved yet; the rows render as a skeleton. */
  loading: boolean;
  values: CustomizeAiValues;
  harness: {
    displayLabel: string;
    field: React.ComponentProps<typeof AgentHarnessField>;
    onReset: () => void;
  };
  provider: {
    displayLabel: string;
    options: readonly PersonaDropdownOption[];
    selectValue: string;
    showCustomInput: boolean;
    onChange: (value: string) => void;
    onCustomIdChange: (value: string) => void;
    onReset: () => void;
    /** Null when the selected provider needs no secret of its own. */
    apiKey: ApiKeyProps | null;
  };
  model: {
    visible: boolean;
    field: React.ComponentProps<typeof PersonaModelField>;
    onReset: () => void;
  };
  fallbacks: {
    entries: readonly string[];
    field: React.ComponentProps<typeof ModelChainField>;
    onReset: () => void;
  };
  reasoning: {
    onChange: (value: string) => void;
    onReset: () => void;
  };
};

function SourcePill({ custom, rowId }: { custom: boolean; rowId: string }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold",
        custom
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
      )}
      data-testid={`customize-ai-pill-${rowId}`}
    >
      {custom ? "custom" : "inherited"}
    </span>
  );
}

function RowAction({
  children,
  disabled,
  expanded,
  onClick,
  testId,
}: {
  children: React.ReactNode;
  disabled: boolean;
  expanded?: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      aria-expanded={expanded}
      className="shrink-0 text-xs font-semibold text-primary disabled:opacity-50"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Row({
  children,
  custom,
  detail,
  disabled,
  expanded,
  note,
  onChangeClick,
  onReset,
  rowId,
  value,
}: {
  /** The picker, revealed under the row by Change. */
  children: React.ReactNode;
  custom: boolean;
  /** Extra content under the value, such as the fallback chips. */
  detail?: React.ReactNode;
  disabled: boolean;
  expanded: boolean;
  note?: React.ReactNode;
  onChangeClick: () => void;
  onReset?: () => void;
  rowId: CustomizeAiRowId;
  value: string;
}) {
  return (
    <div
      className="border-b border-border/60 py-2.5 last:border-b-0"
      data-testid={`customize-ai-row-${rowId}`}
    >
      <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-x-3">
        <span className="text-sm text-muted-foreground">
          {CUSTOMIZE_AI_ROW_LABELS[rowId]}
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground">{value}</span>
          <SourcePill custom={custom} rowId={rowId} />
        </span>
        <span className="flex items-center gap-3">
          <RowAction
            disabled={disabled}
            expanded={expanded}
            onClick={onChangeClick}
            testId={`customize-ai-change-${rowId}`}
          >
            Change
          </RowAction>
          {custom && onReset ? (
            <RowAction
              disabled={disabled}
              onClick={onReset}
              testId={`customize-ai-reset-${rowId}`}
            >
              Reset
            </RowAction>
          ) : note ? (
            <span
              className="text-xs text-muted-foreground"
              data-testid={`customize-ai-note-${rowId}`}
            >
              {note}
            </span>
          ) : null}
        </span>
      </div>
      {detail}
      {expanded ? <div className="mt-2.5">{children}</div> : null}
    </div>
  );
}

function RowsSkeleton() {
  return (
    <div className="space-y-3" data-testid="customize-ai-rows-skeleton">
      {Object.keys(CUSTOMIZE_AI_ROW_LABELS).map((rowId) => (
        <div
          className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3"
          key={rowId}
        >
          <span className="h-3 w-16 rounded bg-muted" />
          <span className="h-3 w-40 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}

export function CustomizeAiRows({
  disabled,
  fallbacks,
  harness,
  loading,
  model,
  provider,
  reasoning,
  values,
}: CustomizeAiRowsProps) {
  const [openRow, setOpenRow] = React.useState<CustomizeAiRowId | null>(null);
  const [useDifferentKey, setUseDifferentKey] = React.useState(false);

  if (loading) {
    return <RowsSkeleton />;
  }

  const custom = customizeAiRowCustomFlags(values);
  function toggle(rowId: CustomizeAiRowId) {
    setOpenRow((current) => (current === rowId ? null : rowId));
  }
  const effortConfig = getProviderEffortConfig(
    values.provider.current || values.provider.inherited,
    values.model.current || values.model.inherited,
  );

  return (
    <div data-testid="customize-ai-rows">
      <Row
        custom={custom.harness}
        detail={harness.field.warning}
        disabled={disabled}
        expanded={openRow === "harness"}
        onChangeClick={() => toggle("harness")}
        onReset={harness.onReset}
        rowId="harness"
        value={harness.displayLabel}
      >
        <AgentHarnessField {...harness.field} warning={undefined} />
      </Row>

      {values.provider.visible ? (
        <Row
          custom={custom.provider}
          disabled={disabled}
          expanded={openRow === "provider"}
          note={providerKeyNote(provider.apiKey?.isInherited ?? true)}
          onChangeClick={() => toggle("provider")}
          onReset={provider.onReset}
          rowId="provider"
          value={provider.displayLabel}
        >
          <div className="space-y-2">
            <PersonaDropdownField
              disabled={disabled}
              id="persona-llm-provider"
              onValueChange={provider.onChange}
              options={provider.options}
              placeholder="Choose a provider"
              value={provider.selectValue}
            />
            {provider.showCustomInput ? (
              <div
                className={cn(
                  "flex min-h-11 items-center px-3",
                  PERSONA_FIELD_SHELL_CLASS,
                )}
              >
                <Input
                  aria-label="Custom provider ID"
                  autoCorrect="off"
                  className={cn(
                    "h-8 px-0 py-0 leading-6",
                    PERSONA_FIELD_CONTROL_CLASS,
                  )}
                  disabled={disabled}
                  id="persona-custom-provider"
                  onChange={(event) =>
                    provider.onCustomIdChange(event.target.value)
                  }
                  placeholder="Custom provider ID"
                  value={values.provider.current}
                />
              </div>
            ) : null}
            {provider.apiKey ? (
              useDifferentKey ? (
                <PersonaProviderApiKeyField
                  disabled={disabled}
                  envVarName={provider.apiKey.envVarName}
                  inheritedLabel={provider.apiKey.inheritedLabel}
                  isInherited={provider.apiKey.isInherited}
                  isRequired={provider.apiKey.isRequired}
                  label={provider.apiKey.label}
                  onValueChange={provider.apiKey.onValueChange}
                  value={provider.apiKey.value}
                />
              ) : (
                <RowAction
                  disabled={disabled}
                  onClick={() => setUseDifferentKey(true)}
                  testId="customize-ai-use-different-key"
                >
                  Use a different key
                </RowAction>
              )
            ) : null}
          </div>
        </Row>
      ) : null}

      {model.visible ? (
        <Row
          custom={custom.model}
          disabled={disabled}
          expanded={openRow === "model"}
          onChangeClick={() => toggle("model")}
          onReset={model.onReset}
          rowId="model"
          value={rowDisplayValue(
            values.model.current,
            values.model.inherited,
            "Harness default",
          )}
        >
          <PersonaModelField {...model.field} />
        </Row>
      ) : null}

      {model.visible ? (
        <Row
          custom={custom.fallbacks}
          detail={
            fallbacks.entries.length > 0 ? (
              <div
                className="mt-1.5 flex flex-wrap gap-1.5 pl-[6.5rem]"
                data-testid="customize-ai-fallback-chips"
              >
                {fallbacks.entries.map((entry, index) => (
                  <span
                    className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-2xs text-muted-foreground"
                    key={entry || `slot-${index}`}
                  >
                    {index + 1} {entry || "Not set"}
                  </span>
                ))}
              </div>
            ) : null
          }
          disabled={disabled}
          expanded={openRow === "fallbacks"}
          onChangeClick={() => toggle("fallbacks")}
          onReset={fallbacks.onReset}
          rowId="fallbacks"
          value={
            custom.fallbacks ? "Custom chain" : "Colony's recommended chain"
          }
        >
          <ModelChainField {...fallbacks.field} />
        </Row>
      ) : null}

      <Row
        custom={custom.reasoning}
        disabled={disabled}
        expanded={openRow === "reasoning"}
        onChangeClick={() => toggle("reasoning")}
        onReset={reasoning.onReset}
        rowId="reasoning"
        value={rowDisplayValue(
          values.reasoning.current,
          values.reasoning.inherited,
          "Harness default",
        )}
      >
        <EffortSelectField
          currentEffort={values.reasoning.current}
          disabled={disabled}
          effortDefault={effortConfig.defaultValue}
          effortValid={effortConfig.validValues}
          htmlFor="customize-ai-reasoning"
          inheritedEffort={values.reasoning.inherited}
          label="Reasoning effort"
          onChange={reasoning.onChange}
          testId="customize-ai-reasoning"
          useCustomSelect
        />
      </Row>
    </div>
  );
}
