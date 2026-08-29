import { cn } from "@/shared/lib/cn";

import type { InitiativeChip } from "../lib/initiativeChips";

const CHIP_CLASS =
  "shrink-0 rounded-full px-2.5 py-1 text-2xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";
const CHIP_ON_CLASS = "bg-primary text-primary-foreground";
const CHIP_OFF_CLASS = "bg-muted text-muted-foreground hover:bg-muted/70";

/**
 * Initiative filter chips (spec "Layout"): derived from the queue, never a
 * fixed list, and they filter the list pane -- they never regroup it and
 * never affect the badge (spec: "the badge stays whole-queue"). Renders
 * nothing when `selectInitiativeChips` found fewer than two buckets: a chip
 * row that can only say "All" filters nothing.
 */
export function ActionCenterInitiativeChips({
  chips,
  initiative,
  onInitiativeChange,
}: {
  chips: readonly InitiativeChip[];
  initiative: string | null;
  onInitiativeChange: (initiative: string | null) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-1.5 px-3 pb-3"
      data-testid="action-center-initiative-chips"
    >
      <button
        aria-pressed={initiative === null}
        className={cn(
          CHIP_CLASS,
          initiative === null ? CHIP_ON_CLASS : CHIP_OFF_CLASS,
        )}
        data-testid="action-center-initiative-chip-all"
        onClick={() => onInitiativeChange(null)}
        type="button"
      >
        All
      </button>
      {chips.map((chip) => (
        <button
          aria-pressed={initiative === chip.id}
          className={cn(
            CHIP_CLASS,
            initiative === chip.id ? CHIP_ON_CLASS : CHIP_OFF_CLASS,
          )}
          data-testid={`action-center-initiative-chip-${chip.id}`}
          key={chip.id}
          onClick={() => onInitiativeChange(chip.id)}
          type="button"
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
