import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import {
  PERSONA_FIELD_CONTROL_CLASS,
  PERSONA_FIELD_SHELL_CLASS,
} from "./agentConfigOptions";

/** Personal name and job title are separate from orchestration rank. */
export function AgentIdentityFields({
  displayName,
  roleTitle,
  roleRequired,
  disabled,
  onNameChange,
  onRoleChange,
}: {
  displayName: string;
  roleTitle: string;
  roleRequired: boolean;
  disabled: boolean;
  onNameChange: (value: string) => void;
  onRoleChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {[
        {
          id: "persona-display-name",
          label: "Agent name",
          value: displayName,
          placeholder: "Sarah",
          onChange: onNameChange,
          required: true,
        },
        {
          id: "persona-role-title",
          label: "Job title",
          value: roleTitle,
          placeholder: "Social media manager",
          onChange: onRoleChange,
          required: roleRequired,
        },
      ].map((field) => (
        <div className="space-y-1.5" key={field.id}>
          <label
            className="text-sm font-medium text-foreground"
            htmlFor={field.id}
          >
            {field.label}
          </label>
          <div
            className={cn(
              "flex min-h-11 items-center px-3",
              PERSONA_FIELD_SHELL_CLASS,
            )}
          >
            <Input
              autoCorrect="off"
              className={cn(
                "h-8 px-0 py-0 leading-6",
                PERSONA_FIELD_CONTROL_CLASS,
              )}
              disabled={disabled}
              id={field.id}
              onChange={(event) => field.onChange(event.target.value)}
              placeholder={field.placeholder}
              required={field.required}
              value={field.value}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
