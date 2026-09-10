import { CheckCircle2, CircleAlert, CircleX, Clock3, Info } from "lucide-react";

import { cn } from "@/shared/lib/cn";
import { Progress } from "@/shared/ui/progress";

import "./blockPresentation.css";
import { resolveStatus } from "./resolvers";
import type { BlockStatusNode, BlockTone } from "./types";

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
  const resolvedState = resolved.state.trim().toLowerCase();
  const isPendingAttentionStatus =
    !node.state_path ||
    resolvedState === "pending" ||
    resolvedState === "pending review";
  const status =
    attentionResolution && isPendingAttentionStatus
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
  const stateLabel = status.state.replaceAll(/[-_]+/g, " ");
  const duplicateLabel =
    status.label.trim().toLowerCase() === stateLabel.trim().toLowerCase();
  const position = "position" in status ? status.position : undefined;
  const total = "total" in status ? status.total : undefined;
  const isSteps = position !== undefined && total !== undefined;
  return (
    <div
      className={cn("min-w-0 space-y-3", className)}
      data-block-primitive="status"
      role="status"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {!duplicateLabel || isSteps ? (
          <span className="block-native-copy min-w-0 text-sm text-muted-foreground">
            {status.label}
          </span>
        ) : null}
        {!isSteps ? (
          <span
            className="block-native-status-pill text-xs font-medium"
            data-tone={status.tone}
          >
            <StatusIcon tone={status.tone} />
            <span className="block-native-copy min-w-0">{stateLabel}</span>
          </span>
        ) : null}
      </div>
      {isSteps ? (
        <div
          className="flex gap-1.5"
          role="progressbar"
          aria-label={status.label}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={position}
          aria-valuetext={`${position} of ${total}`}
        >
          {Array.from({ length: total }, (_, index) => index + 1).map(
            (step) => (
              <span
                key={step}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  step <= position ? "bg-primary" : "bg-muted",
                )}
              />
            ),
          )}
        </div>
      ) : status.progress !== undefined ? (
        <Progress
          className="h-1.5"
          aria-label={`${status.label}: ${status.progress}%`}
          value={status.progress}
        />
      ) : null}
    </div>
  );
}
