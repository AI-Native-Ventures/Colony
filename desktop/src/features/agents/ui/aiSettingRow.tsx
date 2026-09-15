/**
 * The shared shape of an AI setting as a row: a label column, the value the
 * agent will run with, and a pill saying where that value came from.
 *
 * Three surfaces render the same settings and used to look like three
 * different products: the Customize tab of the agent dialog, the "Use agent
 * defaults" summary next to it, and the global Agent defaults dialog. They
 * share this label width and this pill so a reader moving between them is
 * looking at one system.
 */
import type * as React from "react";

import { cn } from "@/shared/lib/cn";

/** Label column plus a value column, wide enough for the labels rows carry. */
const AI_ROW_GRID_CLASS =
  "grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-x-3";

export function AiSourcePill({
  custom,
  testId,
}: {
  custom: boolean;
  testId?: string;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold",
        custom
          ? "bg-primary/10 text-primary"
          : "bg-muted text-muted-foreground",
      )}
      data-testid={testId}
    >
      {custom ? "custom" : "inherited"}
    </span>
  );
}

/**
 * One read-only row: what this setting resolves to, and whether that came
 * from the defaults or from a pin on this agent. No Change, no Reset -- the
 * surfaces that show these rows are summaries, and the editor is one tab or
 * one dialog away.
 */
export function AiSettingRow({
  custom,
  detail,
  label,
  testId,
  value,
}: {
  custom: boolean;
  /** Extra content under the value, such as an override warning. */
  detail?: React.ReactNode;
  label: string;
  testId?: string;
  value: string;
}) {
  return (
    <div
      className="border-b border-border/60 py-2 last:border-b-0"
      data-testid={testId}
    >
      <div className={AI_ROW_GRID_CLASS}>
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-foreground">{value}</span>
          <AiSourcePill custom={custom} testId={testId && `${testId}-pill`} />
        </span>
      </div>
      {detail}
    </div>
  );
}
