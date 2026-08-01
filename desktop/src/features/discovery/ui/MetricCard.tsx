import type { ReactNode } from "react";

import { Card } from "@/shared/ui/card";

export type MetricCardProps = {
  label: string;
  value: ReactNode;
  hint?: string;
};

export function MetricCard({ label, value, hint }: MetricCardProps) {
  return (
    <Card className="border-border/60 bg-background/45 px-3 py-2 shadow-none">
      <p className="text-2xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">
        {value}
      </p>
      {hint ? <p className="text-2xs text-muted-foreground">{hint}</p> : null}
    </Card>
  );
}
