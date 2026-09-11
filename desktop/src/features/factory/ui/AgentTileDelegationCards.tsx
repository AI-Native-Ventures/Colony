import type * as React from "react";
import { CornerDownRight } from "lucide-react";

import type { DelegationCard } from "@/features/factory/lib/delegation";

/**
 * The delegation cards at the top of a tile's transcript column.
 *
 * Both halves of a delegation live in one thread, so the same card list is
 * derived twice — once per tile — and each side renders only its own
 * direction. The card carries the brief itself: the transcript below shows
 * what the agent did about it, not what it was asked.
 */
export function AgentTileDelegationCards({
  cards,
  onOpenThread,
}: {
  cards: ReadonlyArray<DelegationCard>;
  /** Absent until the tile knows which thread the delegation lives in. */
  onOpenThread?: (() => void) | null;
}): React.JSX.Element | null {
  if (cards.length === 0) return null;
  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 border-b border-border/60 px-3 py-2"
      data-testid="agent-tile-delegation-cards"
    >
      {cards.map((card) => (
        <div
          className="rounded-md border border-border/60 bg-muted/40 px-2.5 py-2"
          data-direction={card.direction}
          data-testid="agent-tile-delegation-card"
          key={card.eventId}
        >
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <CornerDownRight aria-hidden className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{card.label}</span>
            {card.direction === "outgoing" && onOpenThread ? (
              <button
                className="ml-auto shrink-0 text-xs font-normal text-muted-foreground hover:text-foreground"
                data-testid="agent-tile-delegation-open-thread"
                onClick={onOpenThread}
                type="button"
              >
                Open thread
              </button>
            ) : null}
          </div>
          {card.body ? (
            <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">
              {card.body}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
