import type * as React from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronRight } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { PanelSectionGroup } from "@/shared/ui/PanelSectionGroup";

export function ProfileIngressRow({
  disabled,
  disclosureIcon: DisclosureIcon = ChevronRight,
  grouped = false,
  icon: Icon,
  label,
  onClick,
  testId,
  trailing,
}: {
  disabled?: boolean;
  disclosureIcon?: LucideIcon;
  grouped?: boolean;
  icon?: LucideIcon;
  label: string;
  onClick?: () => void;
  testId: string;
  trailing?: React.ReactNode;
}) {
  const trailingTitle = typeof trailing === "string" ? trailing : undefined;

  const content = (
    <>
      {Icon ? (
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
        {label}
      </span>
      {trailing ? (
        <span
          className="max-w-[45%] truncate text-right text-sm text-muted-foreground"
          title={trailingTitle}
        >
          {trailing}
        </span>
      ) : null}
      {onClick ? (
        <DisclosureIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : null}
    </>
  );
  const className = cn(
    "flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left",
    onClick &&
      "transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50",
  );

  let row: React.ReactNode;
  if (!onClick) {
    row = (
      <div className={className} data-testid={testId}>
        {content}
      </div>
    );
  } else {
    row = (
      <button
        className={cn(
          className,
          "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
        data-testid={testId}
        disabled={disabled}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return grouped ? (
    row
  ) : (
    <PanelSectionGroup testId={`${testId}-section`}>{row}</PanelSectionGroup>
  );
}
