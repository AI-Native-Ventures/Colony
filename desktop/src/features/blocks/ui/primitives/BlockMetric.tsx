import { cn } from "@/shared/lib/cn";

import "./blockPresentation.css";
import { resolveBlockTemplate, resolveMetric } from "./resolvers";
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
  const comparison = resolveBlockTemplate(node.comparison, data, rootData);
  return (
    <div
      className={cn("block-native-metric", className)}
      data-block-primitive="metric"
    >
      <div className="block-native-copy text-sm text-muted-foreground">
        {metric.label}
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="block-native-copy text-3xl font-semibold leading-tight tracking-tight tabular-nums text-foreground">
          {metric.value || "—"}
        </span>
        {metric.unit ? (
          <span className="block-native-copy text-sm text-muted-foreground">
            {metric.unit}
          </span>
        ) : null}
      </div>
      {comparison ? (
        <p className="block-native-copy mt-3 text-sm text-muted-foreground">
          {comparison}
        </p>
      ) : null}
    </div>
  );
}
