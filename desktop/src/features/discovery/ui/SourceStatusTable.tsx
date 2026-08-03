import { Check, CircleDot, Loader2, Minus, X } from "lucide-react";

import { Badge } from "@/shared/ui/badge";
import { Card } from "@/shared/ui/card";
import { DISCOVERY_SOURCE_LABELS } from "../sourceConfig";
import type { SourceMetric, SourceStatus } from "../types";

export type SourceStatusTableProps = {
  metrics: SourceMetric[];
};

function iconForStatus(status: SourceStatus) {
  if (status === "active" || status === "sampling") return Loader2;
  if (status === "exhausted" || status === "sampled") return Check;
  if (status === "failed") return X;
  if (status === "skipped") return Minus;
  return CircleDot;
}

function variantForStatus(status: SourceStatus) {
  if (status === "failed") return "destructive" as const;
  if (status === "active" || status === "sampling") return "info" as const;
  if (status === "exhausted" || status === "sampled") return "success" as const;
  if (status === "skipped") return "warning" as const;
  return "secondary" as const;
}

export function SourceStatusTable({ metrics }: SourceStatusTableProps) {
  return (
    <Card className="overflow-hidden border-border/60 bg-card/70 p-0 shadow-none">
      <div className="flex items-center justify-between gap-3 border-b border-border/50 p-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Discovery sources
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Source health and lead yield for this run.
          </p>
        </div>
      </div>
      {metrics.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Sources will appear when the campaign starts.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="bg-muted/25 text-left text-2xs uppercase tracking-[0.14em] text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Requests</th>
                <th className="px-4 py-3 text-right font-medium">Found</th>
                <th className="px-4 py-3 text-right font-medium">Stored</th>
                <th className="px-4 py-3 text-right font-medium">Existing</th>
                <th className="px-4 py-3 text-right font-medium">Quality</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((metric) => {
                const Icon = iconForStatus(metric.status);
                return (
                  <tr className="border-t border-border/50" key={metric.source}>
                    <th className="px-4 py-3 text-left font-medium text-foreground">
                      {DISCOVERY_SOURCE_LABELS[metric.source]}
                      {metric.error ? (
                        <span className="mt-1 block max-w-64 text-xs font-normal text-destructive">
                          {metric.error}
                        </span>
                      ) : null}
                    </th>
                    <td className="px-4 py-3">
                      <Badge variant={variantForStatus(metric.status)}>
                        <Icon
                          aria-hidden="true"
                          className={
                            metric.status === "active" ||
                            metric.status === "sampling"
                              ? "animate-spin"
                              : undefined
                          }
                        />
                        {metric.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {metric.requests ?? 0}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {metric.discovered}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-foreground">
                      {metric.stored}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {metric.duplicates}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                      {metric.quality}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
