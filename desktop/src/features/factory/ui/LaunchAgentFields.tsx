import type * as React from "react";

import { AgentDropdownSelect } from "@/features/agents/ui/agentConfigControls";
import { EffortSelectField } from "@/features/agents/ui/buzzAgentModelTuningFields";
import type { LaunchAgentFormState } from "@/features/factory/lib/launchPlan";
import { Input } from "@/shared/ui/input";
import { Textarea } from "@/shared/ui/textarea";

export type LaunchAgentOption = { label: string; value: string };

export type LaunchAgentFieldsProps = {
  disabled: boolean;
  effortDefault: string | null;
  effortValid: ReadonlyArray<string>;
  employees: ReadonlyArray<LaunchAgentOption>;
  form: LaunchAgentFormState;
  modelPlaceholder: string;
  onChange: (patch: Partial<LaunchAgentFormState>) => void;
  runtimes: ReadonlyArray<LaunchAgentOption>;
  teams: ReadonlyArray<LaunchAgentOption>;
};

/**
 * The launcher's form.
 *
 * Every dropdown treats `""` as "inherit from the employee", so a launch that
 * touches nothing produces exactly the agent the employee already describes.
 */
export function LaunchAgentFields({
  disabled,
  effortDefault,
  effortValid,
  employees,
  form,
  modelPlaceholder,
  onChange,
  runtimes,
  teams,
}: LaunchAgentFieldsProps): React.JSX.Element {
  return (
    <div className="space-y-4 py-2">
      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="launch-agent-employee"
        >
          Employee
        </label>
        <AgentDropdownSelect
          disabled={disabled}
          emptyOptionsLabel="No employees available"
          id="launch-agent-employee"
          onValueChange={(value) => onChange({ selectionId: value })}
          options={employees}
          placeholder="Pick an employee"
          placeholderValue=""
          searchable
          testId="launch-agent-employee-select"
          value={form.selectionId}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="launch-agent-team"
          >
            Team (optional)
          </label>
          <AgentDropdownSelect
            disabled={disabled || teams.length === 0}
            emptyOptionsLabel="No teams for this employee"
            id="launch-agent-team"
            onValueChange={(value) => onChange({ teamId: value })}
            options={[{ label: "No team", value: "" }, ...teams]}
            placeholder="No team"
            placeholderValue=""
            testId="launch-agent-team-select"
            value={form.teamId}
          />
        </div>

        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="launch-agent-harness"
          >
            Harness
          </label>
          <AgentDropdownSelect
            disabled={disabled}
            emptyOptionsLabel="No harnesses installed"
            id="launch-agent-harness"
            onValueChange={(value) => onChange({ runtimeId: value })}
            options={[
              { label: "Inherit from employee", value: "" },
              ...runtimes,
            ]}
            placeholder="Inherit from employee"
            placeholderValue=""
            testId="launch-agent-harness-select"
            value={form.runtimeId}
          />
        </div>

        <div className="space-y-1.5">
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="launch-agent-model"
          >
            Model
          </label>
          <Input
            autoComplete="off"
            data-testid="launch-agent-model-input"
            disabled={disabled}
            id="launch-agent-model"
            onChange={(event) => onChange({ model: event.target.value })}
            placeholder={modelPlaceholder}
            value={form.model}
          />
        </div>

        <EffortSelectField
          currentEffort={form.effort}
          disabled={disabled}
          effortDefault={effortDefault}
          effortValid={effortValid}
          htmlFor="launch-agent-effort"
          inheritFallbackLabel="Inherit (employee default)"
          label="Effort"
          onChange={(value) => onChange({ effort: value })}
          testId="launch-agent-effort-select"
          useCustomSelect
        />
      </div>

      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-foreground">
          Worktree
        </legend>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            checked
            data-testid="launch-agent-worktree-shared"
            name="launch-agent-worktree"
            readOnly
            type="radio"
          />
          Share the project checkout
        </label>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input disabled name="launch-agent-worktree" type="radio" />
          Give it its own worktree (not yet available)
        </label>
      </fieldset>

      <div className="space-y-1.5">
        <label
          className="text-sm font-medium text-foreground"
          htmlFor="launch-agent-brief"
        >
          Brief
        </label>
        <Textarea
          data-testid="launch-agent-brief-input"
          disabled={disabled}
          id="launch-agent-brief"
          onChange={(event) => onChange({ brief: event.target.value })}
          placeholder="What should this agent do? It lands in the channel as the first message of the thread."
          value={form.brief}
        />
      </div>
    </div>
  );
}
