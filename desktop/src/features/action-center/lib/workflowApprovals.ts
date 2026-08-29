import { normalizePubkey } from "@/shared/lib/pubkey";
import type {
  Workflow,
  WorkflowApproval,
  WorkflowRun,
} from "@/shared/api/types";
import type { ActionWorkflowSource } from "../contracts";

const HEX_PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * True only when `approverSpec` names this exact pubkey as the approver.
 *
 * The relay's own enforcement (`check_approver_spec` in
 * `buzz-relay/src/handlers/command_executor.rs`) accepts exactly three
 * shapes: `""` and `"any"` (anyone may approve — not a specific person), or a
 * 64-char lowercase hex pubkey (only that exact person). Anything else is
 * rejected at grant time. So "awaits the owner specifically" has one honest
 * definition: the spec is a hex pubkey and it matches this owner's.
 */
export function approverSpecNamesPubkey(
  approverSpec: string,
  pubkey: string,
): boolean {
  const spec = normalizePubkey(approverSpec);
  return HEX_PUBKEY_PATTERN.test(spec) && spec === normalizePubkey(pubkey);
}

/**
 * Build the workflow sources the queue is allowed to show: a run currently
 * waiting on an approval that names the owner specifically, while the
 * `workflows` feature flag is on. Every other run state — running,
 * completed, failed, or an approval anyone may grant — belongs to the
 * Workflows view instead, never to Action Center.
 *
 * `latestRuns` and `pendingApprovals` are parallel to `workflows` (one entry
 * per workflow, `null` where the run or a pending approval could not be
 * resolved yet), matching how the caller's `useQueries` results line up.
 */
export function selectOwnerWorkflowApprovalSources({
  latestRuns,
  ownerPubkey,
  pendingApprovals,
  workflows,
  workflowsEnabled,
}: {
  latestRuns: readonly (WorkflowRun | null)[];
  ownerPubkey: string | null;
  pendingApprovals: readonly (WorkflowApproval | null)[];
  workflows: readonly Workflow[];
  workflowsEnabled: boolean;
}): ActionWorkflowSource[] {
  if (!workflowsEnabled || !ownerPubkey) return [];
  const sources: ActionWorkflowSource[] = [];
  workflows.forEach((workflow, index) => {
    const run = latestRuns[index];
    if (!run || run.status !== "waiting_approval") return;
    const approval = pendingApprovals[index];
    if (!approval || approval.status !== "pending") return;
    if (!approverSpecNamesPubkey(approval.approverSpec, ownerPubkey)) return;
    sources.push({ kind: "workflow", workflow, run, approval });
  });
  return sources;
}
