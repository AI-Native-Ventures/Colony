import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import {
  baseModelOptions,
  composeModelId,
  effortsForModel,
  modelAllowsInheritedEffort,
  splitStoredModel,
} from "./modelEffortOptions";
import type { ReplyModelSelectionControl } from "./useReplyModelSelection";

/** The selection is an unsent request, never evidence that a model has run. */
export function ReplyModelControls({
  control,
  disabled = false,
}: {
  control: ReplyModelSelectionControl;
  disabled?: boolean;
}) {
  if (!control.visible) return null;
  const selected = splitStoredModel(control.selection?.modelId);
  const efforts = effortsForModel(control.models, selected.baseId);
  const inheritedEffort = modelAllowsInheritedEffort(
    control.models,
    selected.baseId,
  );
  const modelOptions = baseModelOptions(control.models);
  const selectedLabel =
    modelOptions.find((model) => model.id === selected.baseId)?.label ??
    selected.baseId;
  const requestedLabel = `${selectedLabel}${selected.effort ? ` · ${selected.effort}` : ""}`;
  const selectClass =
    "h-8 w-full rounded-md border border-border bg-background px-2 text-sm";
  return (
    <Popover
      onOpenChange={(open) => {
        if (open) control.open();
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          data-testid="reply-model-controls"
          className="h-7 max-w-56 gap-1.5 px-2 text-xs"
          title={
            control.selection
              ? `Next reply: ${requestedLabel}`
              : "Model and reasoning for next reply"
          }
          aria-label="Model and reasoning for next reply"
        >
          <SlidersHorizontal className="size-3.5 shrink-0" />
          <span className="truncate">
            {control.selection ? requestedLabel : "Model · Reasoning"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 space-y-3"
        aria-label="Next teammate reply settings"
      >
        <div>
          <p className="text-sm font-medium">Next teammate reply</p>
          <p className="text-xs text-muted-foreground">
            Applies to one reply after you send. A reply already running keeps
            its settings.
          </p>
        </div>
        {control.targets.length > 1 ? (
          <label className="block space-y-1 text-xs">
            Teammate
            <select
              className={selectClass}
              aria-label="Reply teammate"
              value={control.target?.pubkey ?? ""}
              onChange={(event) => {
                control.selectTarget(event.target.value);
                control.open();
              }}
            >
              <option value="">Choose teammate</option>
              {control.targets.map((agent) => (
                <option key={agent.pubkey} value={agent.pubkey}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">
            For {control.target?.name}
          </p>
        )}
        {!control.target ? (
          <p className="text-xs text-muted-foreground">
            Choose the teammate whose reply you want to adjust.
          </p>
        ) : control.loading ? (
          <p role="status" className="text-xs text-muted-foreground">
            Loading available models and reasoning…
          </p>
        ) : control.error ? (
          <div role="alert" className="text-xs">
            <p>{control.error}</p>
            <Button size="sm" variant="ghost" onClick={control.retry}>
              Retry
            </Button>
          </div>
        ) : control.opened && !control.supported ? (
          <p role="status" className="text-xs text-muted-foreground">
            This teammate does not expose reply settings. Its defaults will be
            used.
          </p>
        ) : control.supported ? (
          <>
            <label className="block space-y-1 text-xs">
              Model
              <select
                aria-label="Reply model"
                className={selectClass}
                value={selected.baseId}
                onChange={(event) => {
                  const base = event.target.value;
                  const candidate = composeModelId(base, selected.effort);
                  control.choose(
                    !base
                      ? ""
                      : control.modelIds.includes(candidate)
                        ? candidate
                        : control.modelIds.includes(base)
                          ? base
                          : (control.models.find(
                              (model) => model.baseId === base,
                            )?.id ?? ""),
                  );
                }}
              >
                <option value="">Teammate defaults</option>
                {modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-xs">
              Reasoning
              <select
                aria-label="Reply reasoning"
                className={selectClass}
                value={selected.effort ?? ""}
                disabled={!selected.baseId || efforts.length === 0}
                onChange={(event) =>
                  control.choose(
                    composeModelId(selected.baseId, event.target.value || null),
                  )
                }
              >
                {(!selected.baseId ||
                  inheritedEffort ||
                  efforts.length === 0) && (
                  <option value="">
                    {efforts.length === 0 && selected.baseId
                      ? "Not exposed for this model"
                      : "Teammate defaults"}
                  </option>
                )}
                {efforts.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort}
                  </option>
                ))}
              </select>
            </label>
            {control.selection && (
              <p className="text-xs text-muted-foreground">
                Requested for this message. Availability is checked again when
                the teammate starts.
              </p>
            )}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
