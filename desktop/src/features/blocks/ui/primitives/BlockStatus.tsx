import { CheckCircle2, CircleAlert, CircleX, Clock3, Info } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Progress } from "@/shared/ui/progress";

import { resolveStatus } from "./resolvers";
import type { BlockStatusNode, BlockTone } from "./types";

const BADGE_VARIANT = {
  neutral: "outline",
  info: "info",
  success: "success",
  warning: "warning",
  error: "destructive",
} as const;

function StatusIcon({ tone }: { tone: BlockTone }) {
  const Icon =
    tone === "success"
      ? CheckCircle2
      : tone === "warning"
        ? CircleAlert
        : tone === "error"
          ? CircleX
          : tone === "info"
            ? Clock3
            : Info;
  return <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />;
}

export function BlockStatus({
  attentionResolution,
  className,
  data,
  node,
  rootData,
}: {
  attentionResolution?: "succeeded" | "denied";
  className?: string;
  data: unknown;
  node: BlockStatusNode;
  rootData?: unknown;
}) {
  const resolved = resolveStatus(node, data, rootData);
  const status =
    !node.state_path && attentionResolution
      ? attentionResolution === "succeeded"
        ? {
            label: "Completed",
            state: "Completed",
            tone: "success" as const,
            progress: undefined,
          }
        : {
            label: "Declined",
            state: "Declined",
            tone: "warning" as const,
            progress: undefined,
          }
      : resolved;
  return (
    <div
      className={cn("min-w-0 space-y-2", className)}
      data-block-primitive="status"
      role="status"
    >
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <StatusIcon tone={status.tone} />
          <span className="truncate">{status.label}</span>
        </div>
        <Badge variant={BADGE_VARIANT[status.tone]}>{status.state}</Badge>
      </div>
      {status.progress !== undefined ? (
        <Progress
          aria-label={`${status.label}: ${status.progress}%`}
          value={status.progress}
        />
      ) : null}
    </div>
  );
}
