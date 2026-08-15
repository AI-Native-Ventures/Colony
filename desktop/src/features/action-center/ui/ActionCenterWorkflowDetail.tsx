import { Check, ExternalLink, Play, X } from "lucide-react";

import {
  useApprovalMutation,
  useTriggerWorkflowMutation,
} from "@/features/workflows/hooks";
import { WorkflowRunTrace } from "@/features/workflows/ui/WorkflowRunTrace";
import { isRetryableWorkflowRunStatus } from "@/features/workflows/ui/workflowRunRecovery";
import type { ActionWorkflowSource } from "../contracts";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";

export function ActionCenterWorkflowDetail({
  onOpenSource,
  source,
}: {
  onOpenSource?: () => void;
  source: ActionWorkflowSource;
}) {
  const triggerMutation = useTriggerWorkflowMutation(source.workflow.id);
  const approvalMutation = useApprovalMutation();
  const approval = source.approval;
  const isRetryable = isRetryableWorkflowRunStatus(source.run.status);

  return (
    <section
      className="min-h-full overflow-y-auto"
      data-testid="action-center-workflow-detail"
    >
      <header className="border-b border-border/60 px-5 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Workflow run
          </p>
          <Badge
            variant={
              approval ? "warning" : isRetryable ? "destructive" : "secondary"
            }
          >
            {source.run.status.replace(/_/g, " ")}
          </Badge>
        </div>
        <h2 className="mt-2 text-lg font-semibold text-foreground">
          {source.workflow.name}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Run {source.run.id.slice(0, 12)}
        </p>
      </header>

      <div className="space-y-5 px-5 py-5">
        {approval ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-sm font-semibold">Approval required</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {approval.stepId} · Approver {approval.approverSpec}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                disabled={approvalMutation.isPending}
                onClick={() =>
                  approvalMutation.mutate({
                    action: "grant",
                    note: undefined,
                    token: approval.token,
                  })
                }
                size="sm"
              >
                <Check className="mr-2 size-4" />
                Approve
              </Button>
              <Button
                disabled={approvalMutation.isPending}
                onClick={() =>
                  approvalMutation.mutate({
                    action: "deny",
                    note: undefined,
                    token: approval.token,
                  })
                }
                size="sm"
                variant="destructive"
              >
                <X className="mr-2 size-4" />
                Deny
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {onOpenSource ? (
            <Button onClick={onOpenSource} size="sm" variant="outline">
              <ExternalLink className="mr-2 size-4" />
              Open workflow
            </Button>
          ) : null}
          {isRetryable ? (
            <Button
              disabled={triggerMutation.isPending}
              onClick={() => void triggerMutation.mutateAsync()}
              size="sm"
              variant="secondary"
            >
              <Play className="mr-2 size-4" />
              {triggerMutation.isPending ? "Running…" : "Run again"}
            </Button>
          ) : null}
        </div>
        {triggerMutation.isError || approvalMutation.isError ? (
          <p className="text-sm text-destructive">
            {(triggerMutation.error ?? approvalMutation.error) instanceof Error
              ? (triggerMutation.error ?? approvalMutation.error)?.message
              : "Workflow action failed."}
          </p>
        ) : null}

        <div>
          <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            Execution trace
          </p>
          <WorkflowRunTrace
            approvals={approval ? [approval] : []}
            run={source.run}
          />
        </div>
      </div>
    </section>
  );
}
