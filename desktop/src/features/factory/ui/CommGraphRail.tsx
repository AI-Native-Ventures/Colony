import type * as React from "react";

import type { CommInteraction } from "@/features/factory/lib/commGraph";
import type { CommGraphPerson } from "@/features/factory/ui/CommGraphSvg";
import { formatTime } from "@/features/messages/lib/dateFormatters";

export type CommGraphRailProps = {
  /** The selected pair, or null while nothing is selected. */
  pair: { a: string; b: string } | null;
  interactions: readonly CommInteraction[];
  people: ReadonlyMap<string, CommGraphPerson>;
  /** Open one interaction's thread, or null when it has no reachable thread. */
  onOpenThread: ((interaction: CommInteraction) => void) | null;
};

export function CommGraphRail({
  pair,
  interactions,
  people,
  onOpenThread,
}: CommGraphRailProps): React.JSX.Element {
  const name = (pubkey: string) => people.get(pubkey)?.name ?? "Unknown";
  const askCount = interactions.filter((item) => item.kind === "ask").length;
  const messageCount = interactions.length - askCount;

  return (
    <div
      className="flex h-full min-h-0 w-72 shrink-0 flex-col border-l border-border bg-muted/20"
      data-testid="comm-graph-rail"
    >
      {pair === null ? (
        <div className="px-3 py-3 text-xs text-muted-foreground">
          Click an edge to read the messages behind it.
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-border px-3 py-2">
            <div className="text-sm font-medium text-foreground">
              {name(pair.a)} ↔ {name(pair.b)}
            </div>
            <div className="text-2xs text-muted-foreground">
              {messageCount} message{messageCount === 1 ? "" : "s"}
              {askCount > 0
                ? ` · ${askCount} open ask${askCount === 1 ? "" : "s"}`
                : ""}
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {interactions.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">
                Nothing in this window.
              </div>
            ) : (
              interactions.map((interaction) => (
                <RailRow
                  key={`${interaction.kind}-${interaction.id}-${interaction.to}`}
                  interaction={interaction}
                  fromName={name(interaction.from)}
                  toName={name(interaction.to)}
                  onOpenThread={onOpenThread}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function RailRow({
  interaction,
  fromName,
  toName,
  onOpenThread,
}: {
  interaction: CommInteraction;
  fromName: string;
  toName: string;
  onOpenThread: ((interaction: CommInteraction) => void) | null;
}): React.JSX.Element {
  const isAsk = interaction.kind === "ask";
  const canOpen = onOpenThread !== null;

  return (
    <div
      className="border-b border-border/60 px-3 py-2"
      data-testid="comm-graph-rail-message"
      data-kind={interaction.kind}
      data-from={interaction.from}
      data-to={interaction.to}
    >
      <div className="flex items-center gap-1 text-2xs text-muted-foreground">
        <span className="font-semibold text-foreground">{fromName}</span>
        <span>→ {toName}</span>
        {isAsk ? (
          <span className="rounded-full bg-warning-bg px-1.5 text-2xs text-warning">
            ask
          </span>
        ) : null}
        <span className="ml-auto">{formatTime(interaction.at)}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-foreground">
        {interaction.text}
      </p>
      {canOpen ? (
        <button
          type="button"
          className="mt-1 text-2xs text-primary hover:underline"
          data-testid="comm-graph-open-thread"
          onClick={() => onOpenThread?.(interaction)}
        >
          Open thread
        </button>
      ) : null}
    </div>
  );
}
