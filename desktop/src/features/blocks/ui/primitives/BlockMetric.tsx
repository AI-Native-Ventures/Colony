import { cn } from "@/shared/lib/cn";

import { resolveMetric } from "./resolvers";
import type { BlockMetricNode } from "./types";

export function BlockMetric({
  className,
  data,
  node,
  rootData,
}: {
  className?: string;
  data: unknown;
  node: BlockMetricNode;
  rootData?: unknown;
}) {
  const metric = resolveMetric(node, data, rootData);
  return (
    <div
      className={cn(
        "min-w-0 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5",
        className,
      )}
      data-block-primitive="metric"
    >
      <div className="text-xs font-medium text-muted-foreground">
        {metric.label}
      </div>
      <div className="mt-1 flex min-w-0 items-baseline gap-1.5">
        <span className="truncate text-base font-semibold tabular-nums text-foreground">
          {metric.value || "—"}
        </span>
        {metric.unit ? (
          <span className="text-xs font-medium text-muted-foreground">
            {metric.unit}
          </span>
        ) : null}
      </div>
    </div>
  );
}
