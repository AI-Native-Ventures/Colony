import { SPEND_PERIODS, type SpendPeriod } from "../agentSpend";

/**
 * Choosing how far back to look.
 *
 * A row of pressed buttons rather than a select, following the Credits pack
 * ladder: three choices where the whole decision is visible is not a menu
 * worth opening.
 */
export function SpendPeriodPicker({
  onChange,
  value,
}: {
  onChange: (period: SpendPeriod) => void;
  value: SpendPeriod;
}) {
  return (
    <fieldset
      className="flex flex-wrap gap-1 border-0 p-0"
      data-testid="spend-period-picker"
    >
      <legend className="sr-only">Period</legend>
      {SPEND_PERIODS.map((period) => {
        const selected = period.id === value.id;
        return (
          <button
            aria-pressed={selected}
            className={
              selected
                ? "rounded-full border border-primary bg-primary/10 px-3 py-1 text-2xs font-medium text-primary"
                : "rounded-full border border-border/70 bg-background/40 px-3 py-1 text-2xs font-medium text-muted-foreground transition-colors hover:border-primary/50"
            }
            data-testid={`spend-period-${period.id}`}
            key={period.id}
            onClick={() => onChange(period)}
            type="button"
          >
            {period.label}
          </button>
        );
      })}
    </fieldset>
  );
}
