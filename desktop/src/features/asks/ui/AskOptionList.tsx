import type * as React from "react";

import type { AskOption } from "@/features/asks/lib/askOptions";
import { Badge } from "@/shared/ui/badge";
import { cn } from "@/shared/lib/cn";

type AskOptionListProps = {
  options: readonly AskOption[];
  selectedLabel: string | null;
  onSelect: (label: string) => void;
  disabled: boolean;
};

/**
 * The choices an ask offers, each with the consequence it causes.
 *
 * Keyboard and screen-reader behaviour comes from native `<input
 * type="radio">` inside a `<fieldset>`, not from a hand-rolled listbox: a
 * native radio group already gives arrow-key roving focus, one tab stop, and
 * the correct group/`aria-checked` semantics for free.
 *
 * There is no Radix radio group in this app to reuse. `@radix-ui/react-radio-group`
 * is not a dependency, and the one grouped-choice primitive that IS here,
 * `DropdownMenuRadioGroup`, hides its items behind a trigger, which would put
 * the consequences (the entire reason for rendering options instead of a
 * textarea) out of sight until the menu is open.
 */
export function AskOptionList({
  options,
  selectedLabel,
  onSelect,
  disabled,
}: AskOptionListProps): React.JSX.Element {
  return (
    <fieldset className="flex flex-col gap-2" data-testid="ask-options">
      <legend className="mb-1 text-xs text-muted-foreground">
        Pick one. What each choice causes is written underneath it.
      </legend>
      {options.map((option) => {
        const isSelected = option.label === selectedLabel;
        return (
          <label
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors",
              isSelected
                ? "border-primary bg-primary/5"
                : "border-border bg-background hover:bg-muted/40",
              disabled && "cursor-not-allowed opacity-60",
            )}
            data-testid={`ask-option-${option.label}`}
            key={option.label}
          >
            <input
              checked={isSelected}
              className="mt-1 size-4 shrink-0 accent-primary"
              disabled={disabled}
              name="ask-option"
              onChange={() => onSelect(option.label)}
              type="radio"
              value={option.label}
            />
            <span className="flex min-w-0 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  {option.label}
                </span>
                {option.recommended ? (
                  <Badge data-testid="ask-option-recommended" variant="success">
                    Recommended
                  </Badge>
                ) : null}
                {option.isDefault ? (
                  <Badge data-testid="ask-option-default" variant="warning">
                    Happens if you do not answer
                  </Badge>
                ) : null}
              </span>
              <span className="text-xs leading-4 text-muted-foreground">
                {option.consequence ??
                  "The agent did not say what this choice causes."}
              </span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
