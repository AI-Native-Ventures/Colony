import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import {
  baseModelOptions,
  composeModelId,
  effortsForModel,
  modelAllowsInheritedEffort,
  splitStoredModel,
} from "./modelEffortOptions";
import type { ReplyModelSelectionControl } from "./useReplyModelSelection";

function ReplyChoice({
  label,
  value,
  disabled,
  title,
  onOpen,
  children,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  title?: string;
  onOpen?: () => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu onOpenChange={(open) => open && onOpen?.()}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Reply ${label.toLowerCase()}`}
          title={title ?? `${label}: ${value}`}
          className="h-7 min-w-0 max-w-full gap-1.5 rounded-md border border-border/60 bg-background/50 px-2 text-xs font-normal"
        >
          <span className="shrink-0 text-muted-foreground">{label}</span>
          <span className="min-w-0 truncate">{value}</span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        collisionPadding={12}
        aria-label={`Reply ${label.toLowerCase()} choices`}
        className="w-72 max-w-[calc(100vw-2rem)]"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Compact unsent choices for one reply; only opening Model starts discovery. */
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
  const reasoningUnavailable = !!selected.baseId && efforts.length === 0;
  return (
    <div
      data-testid="reply-model-controls"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 pb-1 pt-2"
    >
      {control.targets.length > 1 ? (
        <ReplyChoice
          label="Teammate"
          value={control.target?.name ?? "Choose"}
          disabled={disabled}
        >
          <DropdownMenuLabel>For this reply</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={control.target?.pubkey ?? ""}
            onValueChange={control.selectTarget}
          >
            <DropdownMenuRadioItem value="" disabled={disabled}>
              Choose teammate
            </DropdownMenuRadioItem>
            {control.targets.map((agent) => (
              <DropdownMenuRadioItem
                key={agent.pubkey}
                value={agent.pubkey}
                disabled={disabled}
                className="break-words"
              >
                {agent.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </ReplyChoice>
      ) : (
        <span
          className="max-w-24 truncate text-xs text-muted-foreground"
          title={`For ${control.target?.name}`}
        >
          {control.target?.name}
        </span>
      )}
      <ReplyChoice
        label="Model"
        value={selectedLabel || "Default"}
        disabled={disabled || !control.target}
        title={!control.target ? "Choose a teammate first" : undefined}
        onOpen={control.open}
      >
        <DropdownMenuLabel>Model for this reply</DropdownMenuLabel>
        {control.loading ? (
          <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
            Loading available models and reasoning…
          </p>
        ) : control.error ? (
          <>
            <p role="alert" className="break-words px-2 py-2 text-sm">
              {control.error}
            </p>
            <DropdownMenuItem
              disabled={disabled}
              onSelect={(event) => {
                event.preventDefault();
                control.retry();
              }}
            >
              Retry
            </DropdownMenuItem>
          </>
        ) : control.opened && !control.supported ? (
          <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
            This teammate does not expose reply settings. Its defaults will be
            used.
          </p>
        ) : control.supported ? (
          <DropdownMenuRadioGroup
            value={selected.baseId}
            onValueChange={(base) => {
              const candidate = composeModelId(base, selected.effort);
              control.choose(
                !base
                  ? ""
                  : control.modelIds.includes(candidate)
                    ? candidate
                    : control.modelIds.includes(base)
                      ? base
                      : (control.models.find((model) => model.baseId === base)
                          ?.id ?? ""),
              );
            }}
          >
            <DropdownMenuRadioItem value="" disabled={disabled}>
              Teammate defaults
            </DropdownMenuRadioItem>
            {modelOptions.map((model) => (
              <DropdownMenuRadioItem
                key={model.id}
                value={model.id}
                disabled={disabled}
                className="break-words"
              >
                {model.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : null}
      </ReplyChoice>
      <ReplyChoice
        label="Reasoning"
        value={
          selected.effort ?? (reasoningUnavailable ? "Not exposed" : "Default")
        }
        title={
          !selected.baseId
            ? "Choose a model to see its available reasoning"
            : reasoningUnavailable
              ? "Not exposed for this model"
              : undefined
        }
        disabled={
          disabled ||
          control.loading ||
          !!control.error ||
          !control.supported ||
          !selected.baseId ||
          efforts.length === 0
        }
      >
        <DropdownMenuLabel>Reasoning for this reply</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={selected.effort ?? ""}
          onValueChange={(effort) =>
            control.choose(composeModelId(selected.baseId, effort || null))
          }
        >
          {inheritedEffort && (
            <DropdownMenuRadioItem value="" disabled={disabled}>
              Teammate defaults
            </DropdownMenuRadioItem>
          )}
          {efforts.map((effort) => (
            <DropdownMenuRadioItem
              key={effort}
              value={effort}
              disabled={disabled}
            >
              {effort}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </ReplyChoice>
      <span className="text-xs text-muted-foreground">This reply only</span>
    </div>
  );
}
