import * as React from "react";
import { Check, LoaderCircle } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import { resolveActionAvailability } from "./resolvers";
import type {
  BlockActionControl,
  BlockActionEnvironment,
  BlockActionsNode,
} from "./types";

async function invokeControl(
  control: BlockActionControl,
  environment: BlockActionEnvironment,
) {
  if (control.interaction.type === "signed") {
    await environment.submitSigned?.(
      control.interaction,
      environment.directActionInputs?.get(control.interaction.action_id) ?? {},
    );
  } else {
    await environment.openPresentation?.(control.interaction);
  }
}

export function BlockActions({
  className,
  environment,
  node,
}: {
  className?: string;
  environment?: BlockActionEnvironment;
  node: BlockActionsNode;
}) {
  const reasonIdPrefix = React.useId();

  return (
    <fieldset
      className={cn("flex flex-wrap items-center gap-2", className)}
      data-block-primitive="actions"
    >
      <legend className="sr-only">Block actions</legend>
      {node.controls
        .filter(
          (control) =>
            !environment?.hideIndirectSignedActions ||
            control.interaction.type !== "signed" ||
            environment.directActionIds?.has(control.interaction.action_id),
        )
        .map((control, index) => {
          const availability = resolveActionAvailability(control, environment);
          const controlKey =
            control.interaction.type === "signed"
              ? `signed:${control.interaction.action_id}`
              : `presentation:${control.interaction.surface}:${control.label}`;
          const reasonId = `${reasonIdPrefix}-${controlKey}-reason`;
          return (
            <div className="contents" key={controlKey}>
              <Button
                aria-describedby={
                  !availability.enabled && availability.reason
                    ? reasonId
                    : undefined
                }
                disabled={
                  !availability.enabled ||
                  availability.pending ||
                  availability.completed
                }
                onClick={() => {
                  if (environment && availability.enabled) {
                    void invokeControl(control, environment);
                  }
                }}
                size="sm"
                type="button"
                variant={index === 0 ? "default" : "outline"}
              >
                {availability.pending ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : null}
                {availability.completed ? <Check aria-hidden="true" /> : null}
                {control.label}
              </Button>
              {!availability.enabled && availability.reason ? (
                <span className="sr-only" id={reasonId}>
                  {availability.reason}
                </span>
              ) : null}
            </div>
          );
        })}
    </fieldset>
  );
}
