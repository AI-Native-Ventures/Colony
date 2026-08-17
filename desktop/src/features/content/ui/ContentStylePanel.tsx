import { Badge } from "@/shared/ui/badge";

import type { ContentStyle } from "../contracts";

/**
 * The house style: every correction the owner ever made, written down.
 *
 * Each rule cites the date and the sentence that caused it. Without the list,
 * accumulated corrections become an unauditable prompt nobody can debug in
 * week six. Without the origin, nobody dares delete anything, because they
 * cannot tell whether a rule still matters or was a one-off from March.
 *
 * Revoked rules stay, greyed. A rule that vanished without a trace is a rule
 * nobody can argue with later.
 */

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function ContentStylePanel({ style }: { style: ContentStyle | null }) {
  if (!style || style.rules.length === 0) {
    return (
      <div className="p-4">
        <h2 className="text-lg font-semibold">Style</h2>
        <p className="mt-2 max-w-prose text-sm text-muted-foreground">
          Nothing here yet. Every time you send a card back and say the
          correction should apply to every card, it lands in this list with the
          sentence you used. Over months this becomes your taste, written down,
          and it exists nowhere else.
        </p>
      </div>
    );
  }

  const active = style.rules.filter((rule) => rule.active);
  const revoked = style.rules.filter((rule) => !rule.active);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold">Style</h2>
        {style.version ? (
          <Badge variant="outline">{style.version}</Badge>
        ) : null}
      </div>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        {active.length} rule{active.length === 1 ? "" : "s"} every card follows.
        Each one cites what you said to cause it.
      </p>

      <ul className="mt-4 space-y-3">
        {active.map((rule) => (
          <li
            className="rounded-lg border border-border/60 bg-muted/10 p-3"
            key={rule.id}
          >
            <p className="text-sm font-medium">{rule.text}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              From {formatDate(rule.origin.at)}: “{rule.origin.quote}”
            </p>
          </li>
        ))}
      </ul>

      {revoked.length > 0 ? (
        <>
          <h3 className="mt-6 text-sm font-medium text-muted-foreground">
            No longer applied
          </h3>
          <ul className="mt-2 space-y-2">
            {revoked.map((rule) => (
              <li
                className="rounded-lg border border-border/40 p-3 opacity-60"
                key={rule.id}
              >
                <p className="text-sm line-through">{rule.text}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  From {formatDate(rule.origin.at)}: “{rule.origin.quote}”
                </p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
