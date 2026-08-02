import type { ReactNode } from "react";

import { Card } from "@/shared/ui/card";

export type MetricCardProps = {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: ReactNode;
};

export function MetricCard({ label, value, hint, icon }: MetricCardProps) {
  return (
    <Card className="rounded-2xl border-border/60 bg-card/70 p-4.5 shadow-none">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
          {icon}
        </div>
      </div>
      <p className="font-serif text-3xl font-normal leading-none tabular-nums text-foreground">
        {value}
      </p>
      <p className="mt-2 text-sm font-semibold text-foreground">{label}</p>
      {hint ? (
        <p className="mt-1 text-2xs text-muted-foreground">{hint}</p>
      ) : null}
    </Card>
  );
}
