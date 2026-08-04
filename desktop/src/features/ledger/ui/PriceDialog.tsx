import * as React from "react";

import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

import { EMPTY_PRICE, type PriceRequest, priceProblem } from "../prices";

/**
 * Publishing what a model costs.
 *
 * Every rate is asked for in dollars per million tokens, matching the
 * vendor's own pricing page, so the number can be copied across without
 * arithmetic. Fields start blank rather than at zero: zero is a real rate,
 * and a pre-filled zero is a free price published by not noticing.
 */

function Rate({
  hint,
  htmlFor,
  label,
  onChange,
  value,
}: {
  hint?: string;
  htmlFor: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div>
      <label
        className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
        htmlFor={htmlFor}
      >
        {label}
      </label>
      <Input
        className="mt-1"
        id={htmlFor}
        inputMode="decimal"
        onChange={(event) => onChange(event.target.value)}
        placeholder="0"
        value={value}
      />
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

export function PriceDialog({
  isSubmitting,
  onOpenChange,
  onSubmit,
  open,
  submitError,
}: {
  isSubmitting: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (request: PriceRequest) => void;
  open: boolean;
  submitError: Error | null;
}) {
  const [draft, setDraft] = React.useState<PriceRequest>(EMPTY_PRICE);
  const fieldId = React.useId();

  React.useEffect(() => {
    if (open) setDraft(EMPTY_PRICE);
  }, [open]);

  const set = (patch: Partial<PriceRequest>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const problem = priceProblem(draft);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" data-testid="ledger-price-dialog">
        <DialogHeader>
          <DialogTitle>Add a price</DialogTitle>
          <DialogDescription>
            Rates are dollars per million tokens, the same unit the provider
            quotes, so you can copy them across. Prices are never overwritten:
            publishing a new one leaves earlier spend priced as it was at the
            time.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label
              className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
              htmlFor={`${fieldId}-model`}
            >
              Model
            </label>
            <Input
              className="mt-1"
              id={`${fieldId}-model`}
              onChange={(event) => set({ model: event.target.value })}
              placeholder="claude-sonnet-4-5"
              value={draft.model}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Exactly as the provider names it. This is what the recorded calls
              are matched against.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Rate
              htmlFor={`${fieldId}-input`}
              label="Input"
              onChange={(value) => set({ inputPerMtok: value })}
              value={draft.inputPerMtok}
            />
            <Rate
              htmlFor={`${fieldId}-output`}
              label="Output"
              onChange={(value) => set({ outputPerMtok: value })}
              value={draft.outputPerMtok}
            />
            <Rate
              htmlFor={`${fieldId}-cache-read`}
              label="Cache read"
              onChange={(value) => set({ cacheReadPerMtok: value })}
              value={draft.cacheReadPerMtok}
            />
            <Rate
              htmlFor={`${fieldId}-cache-5m`}
              label="Cache write (5 min)"
              onChange={(value) => set({ cacheWrite5mPerMtok: value })}
              value={draft.cacheWrite5mPerMtok}
            />
            <Rate
              htmlFor={`${fieldId}-cache-1h`}
              label="Cache write (1 hour)"
              onChange={(value) => set({ cacheWrite1hPerMtok: value })}
              value={draft.cacheWrite1hPerMtok}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Enter 0 for any rate the provider does not charge for.
          </p>

          <div>
            <label
              className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground"
              htmlFor={`${fieldId}-note`}
            >
              Note (optional)
            </label>
            <Input
              className="mt-1"
              id={`${fieldId}-note`}
              onChange={(event) => set({ note: event.target.value })}
              placeholder="Launch pricing, or: promo ends 30 Sept"
              value={draft.note ?? ""}
            />
          </div>
        </div>

        {submitError ? (
          <p className="text-sm text-destructive" role="alert">
            {submitError.message}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
            type="button"
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            data-testid="ledger-price-submit"
            disabled={problem !== null || isSubmitting}
            onClick={() => onSubmit(draft)}
            title={problem ?? undefined}
            type="button"
          >
            {isSubmitting ? "Publishing…" : "Publish price"}
          </Button>
        </DialogFooter>
        {problem ? (
          <p className="text-xs text-muted-foreground">{problem}</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
