import { AlertTriangle, Info } from "lucide-react";

import { Button } from "@/shared/ui/button";

import type { AttentionItem } from "../lib/summarize";

/**
 * What stands between the owner and a total they can trust.
 *
 * Placed above the numbers rather than below them. A blocking item means
 * the figures on this page are known to be incomplete, and a reader who
 * meets the total first has already believed it by the time they reach the
 * caveat.
 */
export function LedgerAttention({
  items,
  onAddPrice,
}: {
  items: readonly AttentionItem[];
  /** Absent when the viewer cannot publish prices. */
  onAddPrice?: () => void;
}) {
  if (items.length === 0) return null;

  return (
    <section
      aria-label="Needs attention"
      className="space-y-2"
      data-testid="ledger-attention"
    >
      {items.map((item) => {
        const blocking = item.severity === "blocking";
        const Icon = blocking ? AlertTriangle : Info;
        return (
          <div
            className={
              blocking
                ? "flex gap-3 rounded-2xl border border-destructive/25 bg-destructive/5 px-4 py-3"
                : "flex gap-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-3"
            }
            key={item.id}
            role={blocking ? "alert" : undefined}
          >
            <Icon
              aria-hidden="true"
              className={
                blocking
                  ? "mt-0.5 size-4 shrink-0 text-destructive"
                  : "mt-0.5 size-4 shrink-0 text-muted-foreground"
              }
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">
                {item.title}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {item.detail}
              </p>
              {item.action === "add-price" && onAddPrice ? (
                <Button
                  className="mt-2"
                  data-testid="ledger-add-price"
                  onClick={onAddPrice}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Add a price
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
    </section>
  );
}
