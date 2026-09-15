/**
 * The fallback chain editor: which models an agent tries, in order, when its
 * own model refuses.
 *
 * Two states, one field. With no authored chain the rows are Colony's
 * recommended chain, read-only, because that is what actually reaches the
 * agent and the owner should be able to see it without taking ownership of it.
 * Customize copies those ids into an authored chain, and from there the rows
 * are sortable, each with the model picker the Model field uses.
 *
 * Presentation only: every rule it enforces lives in `modelChain.lib.ts`, and
 * the backend normalizes the chain again on save.
 */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  GripVertical,
  X,
} from "lucide-react";
import * as React from "react";

import {
  AgentConfigTextInput,
  AgentDropdownSelect,
} from "@/features/agents/ui/agentConfigControls";
import {
  CUSTOM_MODEL_DROPDOWN_VALUE,
  type PersonaModelOption,
} from "@/features/agents/ui/agentConfigOptions";
import {
  chainOrderWarning,
  fallbackOptionsForSlot,
  isFreeModelId,
  moveChainEntry,
  normalizeChain,
  remainingChainSlots,
} from "@/features/agents/ui/modelChain.lib";
import { buildModelDropdownOptionsForScope } from "@/features/agents/ui/runtimeModelProviderSelection";
import { cn } from "@/shared/lib/cn";

const FIELD_LABEL = "If that model is unavailable, try in order";

type ChainSlot = { id: string; custom: boolean };

export type ModelChainFieldProps = {
  /** Authored chain, or null to inherit Colony's recommended chain. */
  value: string[] | null;
  /** The relay's own ranking, shown while `value` is null. */
  recommended: string[];
  onChange: (next: string[] | null) => void;
  /** Discovered models for the current provider; null while unknown. */
  options: readonly PersonaModelOption[] | null;
  /** Tried first, so it is never offered as a fallback. */
  primaryModel: string;
  disabled?: boolean;
  /** False for every provider but OpenRouter, which is the only one with a chain. */
  providerSupportsChain: boolean;
  /** Discovery is still running, so the picker says so instead of "no models". */
  optionsLoading?: boolean;
};

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <span className="text-sm font-medium">{children}</span>;
}

function FreeBadge() {
  return (
    <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-2xs font-semibold text-emerald-700 dark:text-emerald-400">
      free
    </span>
  );
}

function RowShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-t border-border/60 px-3 py-2 text-xs first:border-t-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

function SlotNumber({ position }: { position: number }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-2xs font-semibold text-muted-foreground">
      {position}
    </span>
  );
}

/** One authored entry: drag handle, picker, badge, keyboard moves, remove. */
function ChainRow({
  chain,
  customEditing,
  disabled,
  index,
  onCustomEditingChange,
  onEntryChange,
  onMove,
  onRemove,
  options,
  optionsLoading,
  primaryModel,
  slotId,
}: {
  chain: string[];
  customEditing: boolean;
  disabled: boolean;
  index: number;
  onCustomEditingChange: (index: number, editing: boolean) => void;
  onEntryChange: (index: number, entry: string) => void;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  options: readonly PersonaModelOption[] | null;
  optionsLoading: boolean;
  primaryModel: string;
  /** Stable across reorders, so a row keeps its DOM and its open picker. */
  slotId: string;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: slotId });
  const entry = chain[index] ?? "";
  const slotOptions = fallbackOptionsForSlot({
    chain,
    index,
    options: options ?? [],
    primaryModel,
  });
  const dropdownOptions = buildModelDropdownOptionsForScope(
    false,
    optionsLoading,
    slotOptions,
  );
  // An id is only "custom" once the provider's list is actually known. While
  // discovery is in flight every id looks unknown, and flipping the row into
  // custom entry there would hand the user a text box over a model they picked
  // from the list a moment ago.
  const optionsKnown = options !== null && !optionsLoading;
  const known = slotOptions.some((option) => option.id === entry);
  const showCustomInput =
    customEditing || (entry.length > 0 && optionsKnown && !known);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <RowShell>
        <button
          aria-label={`Reorder fallback ${index + 1}`}
          className="cursor-grab text-muted-foreground/60 disabled:cursor-not-allowed"
          disabled={disabled}
          type="button"
          {...attributes}
          {...listeners}
        >
          <GripVertical aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <SlotNumber position={index + 1} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <AgentDropdownSelect
            disabled={disabled}
            emptyOptionsLabel="Couldn't load models"
            id={`agent-fallback-model-${index}`}
            onValueChange={(next) => {
              if (next === CUSTOM_MODEL_DROPDOWN_VALUE) {
                onCustomEditingChange(index, true);
                return;
              }
              onCustomEditingChange(index, false);
              onEntryChange(index, next);
            }}
            options={dropdownOptions}
            placeholder="Select a model"
            searchable
            selectedLabel={showCustomInput ? undefined : entry || undefined}
            testId={`agent-fallback-model-${index}`}
            value={showCustomInput ? CUSTOM_MODEL_DROPDOWN_VALUE : entry}
          />
          {showCustomInput ? (
            <AgentConfigTextInput
              aria-label={`Custom fallback model ID ${index + 1}`}
              autoCorrect="off"
              disabled={disabled}
              onChange={(event) => onEntryChange(index, event.target.value)}
              placeholder="Custom model ID"
              value={entry}
            />
          ) : null}
        </div>
        {isFreeModelId(entry) ? <FreeBadge /> : null}
        <button
          aria-label={`Move fallback ${index + 1} up`}
          className="rounded p-0.5 text-muted-foreground/70 hover:bg-muted disabled:opacity-40"
          disabled={disabled || index === 0}
          onClick={() => onMove(index, index - 1)}
          type="button"
        >
          <ChevronUp aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <button
          aria-label={`Move fallback ${index + 1} down`}
          className="rounded p-0.5 text-muted-foreground/70 hover:bg-muted disabled:opacity-40"
          disabled={disabled || index === chain.length - 1}
          onClick={() => onMove(index, index + 1)}
          type="button"
        >
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <button
          aria-label={`Remove fallback ${index + 1}`}
          className="rounded p-0.5 text-muted-foreground/70 hover:bg-muted"
          disabled={disabled}
          onClick={() => onRemove(index)}
          type="button"
        >
          <X aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
      </RowShell>
    </div>
  );
}

export function ModelChainField({
  disabled = false,
  onChange,
  options,
  optionsLoading = false,
  primaryModel,
  providerSupportsChain,
  recommended,
  value,
}: ModelChainFieldProps) {
  // Per-row state the chain itself cannot carry: a stable id (React key and
  // sortable id) and whether the row is in custom-id entry. Kept parallel to
  // the chain and moved by the same permutation, so a reorder or a removal
  // carries both with their row rather than stranding them on whatever entry
  // inherited the index.
  const [slots, setSlots] = React.useState<ChainSlot[]>([]);
  const nextSlotIdRef = React.useRef(0);
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  if (!providerSupportsChain) {
    return (
      <div className="space-y-1.5" data-testid="model-chain-field">
        <FieldLabel>{FIELD_LABEL}</FieldLabel>
        <div
          className="rounded-xl border border-input bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground"
          data-testid="model-chain-unsupported"
        >
          Fallbacks need OpenRouter
        </div>
      </div>
    );
  }

  if (value === null) {
    return (
      <div className="space-y-1.5" data-testid="model-chain-field">
        <FieldLabel>{FIELD_LABEL}</FieldLabel>
        <div className="overflow-hidden rounded-xl border border-input">
          {recommended.length === 0 ? (
            <RowShell className="text-muted-foreground">
              Colony has not published a chain for this community yet.
            </RowShell>
          ) : (
            recommended.map((entry, index) => (
              <RowShell key={entry}>
                <SlotNumber position={index + 1} />
                <span className="min-w-0 flex-1 truncate">{entry}</span>
                {isFreeModelId(entry) ? <FreeBadge /> : null}
              </RowShell>
            ))
          )}
        </div>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            Source:{" "}
            <span className="font-medium text-foreground">
              Colony's recommendation
            </span>
          </span>
          <button
            className="font-semibold text-primary disabled:opacity-50"
            data-testid="model-chain-customize"
            disabled={disabled}
            onClick={() => {
              const seeded = normalizeChain(recommended);
              setSlots(
                seeded.map(() => ({
                  custom: false,
                  id: `fallback-${nextSlotIdRef.current++}`,
                })),
              );
              onChange(seeded);
            }}
            type="button"
          >
            Customize
          </button>
        </div>
      </div>
    );
  }

  const chain = value;
  const remaining = remainingChainSlots(chain);
  const warning = chainOrderWarning(primaryModel, chain);
  // A chain seeded by the parent (a loaded config, a reset) arrives without
  // slot state, so fall back to positional ids until the next edit builds it.
  const chainSlots: ChainSlot[] =
    slots.length === chain.length
      ? slots
      : chain.map((_, index) => ({
          custom: false,
          id: `fallback-position-${index}`,
        }));

  function applyChain(next: string[], nextSlots: ChainSlot[]) {
    setSlots(nextSlots);
    onChange(next);
  }

  function handleMove(from: number, to: number) {
    applyChain(
      moveChainEntry(chain, from, to),
      moveChainEntry(chainSlots, from, to),
    );
  }

  function handleDragEnd(event: DragEndEvent) {
    const from = chainSlots.findIndex((slot) => slot.id === event.active.id);
    const to = chainSlots.findIndex((slot) => slot.id === event.over?.id);
    if (from === -1 || to === -1 || from === to) return;
    handleMove(from, to);
  }

  return (
    <div className="space-y-1.5" data-testid="model-chain-field">
      <FieldLabel>{FIELD_LABEL}</FieldLabel>
      <div className="overflow-hidden rounded-xl border border-input">
        {chain.length === 0 ? (
          <RowShell className="text-muted-foreground">
            No fallbacks. This agent stops at its own model.
          </RowShell>
        ) : (
          <DndContext
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
            sensors={sensors}
          >
            <SortableContext
              items={chainSlots.map((slot) => slot.id)}
              strategy={verticalListSortingStrategy}
            >
              {chainSlots.map((slot, index) => (
                <ChainRow
                  chain={chain}
                  customEditing={slot.custom}
                  disabled={disabled}
                  index={index}
                  key={slot.id}
                  onCustomEditingChange={(position, editing) => {
                    const nextSlots = chainSlots.map((existing, i) =>
                      i === position
                        ? { ...existing, custom: editing }
                        : existing,
                    );
                    if (!editing) {
                      setSlots(nextSlots);
                      return;
                    }
                    // Entering custom entry clears the slot so the input starts
                    // empty rather than inviting an edit of a known id.
                    const next = [...chain];
                    next[position] = "";
                    applyChain(next, nextSlots);
                  }}
                  onEntryChange={(position, next) => {
                    const updated = [...chain];
                    updated[position] = next;
                    applyChain(updated, chainSlots);
                  }}
                  onMove={handleMove}
                  onRemove={(position) =>
                    applyChain(
                      chain.filter((_, i) => i !== position),
                      chainSlots.filter((_, i) => i !== position),
                    )
                  }
                  options={options}
                  optionsLoading={optionsLoading}
                  primaryModel={primaryModel}
                  slotId={slot.id}
                />
              ))}
            </SortableContext>
          </DndContext>
        )}
        {remaining > 0 ? (
          <button
            className="w-full border-t border-dashed border-border/60 px-3 py-2 text-left text-xs font-semibold text-primary disabled:opacity-50"
            data-testid="model-chain-add"
            disabled={disabled}
            onClick={() =>
              applyChain(
                [...chain, ""],
                [
                  ...chainSlots,
                  { custom: false, id: `fallback-${nextSlotIdRef.current++}` },
                ],
              )
            }
            type="button"
          >
            + Add a fallback ({remaining} left)
          </button>
        ) : null}
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          Source: <span className="font-medium text-foreground">Custom</span>
        </span>
        <button
          className="font-semibold text-primary disabled:opacity-50"
          data-testid="model-chain-use-recommended"
          disabled={disabled}
          onClick={() => {
            setSlots([]);
            onChange(null);
          }}
          type="button"
        >
          Use Colony's recommended chain
        </button>
      </div>
      {warning ? (
        <div
          className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning-bg px-3 py-2.5 text-xs text-warning"
          data-testid="model-chain-warning"
          role="status"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
          />
          <span>{warning}</span>
        </div>
      ) : null}
    </div>
  );
}
