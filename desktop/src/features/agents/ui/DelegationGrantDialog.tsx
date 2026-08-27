import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";

import {
  delegationGrantDraftProblem,
  publishDelegationGrant,
} from "@/features/agents/delegationGrantActions";
import { delegationGrantsQueryKey } from "@/features/agents/delegationGrants";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { Input } from "@/shared/ui/input";

/**
 * Delegating one category of decisions to the community's leaders.
 *
 * Fields mirror the grant content the relay parses (`parse_grant`): id,
 * category, scope, optional spending cap. Refusals render before signing --
 * a hard-list category or wildcard scope never reaches the relay -- and the
 * relay still re-validates schema plus owner authorship at ingest, so its
 * verdict, not this form's, is final.
 *
 * The cap is entered in dollars and published as integer nanoUSD, the unit
 * every cap comparison on the relay uses.
 *
 * Two fields are deliberately worded down from what they look like:
 *
 * - The cap is a PER-DECISION ceiling. `enforce_decision_log_authority`
 *   checks one decision's amount against it and never sums the ones already
 *   logged under the same grant, so a capped grant bounds no total. Calling
 *   it a "spending cap" invited an owner to read a budget into it, which is
 *   the one reading that is false.
 * - `scope` is descriptive only. The relay refuses a wildcard and then never
 *   verifies that any decision falls inside what was written, so it is an
 *   instruction to the agent, not a restriction the system applies.
 */

const NANO_USD_PER_DOLLAR = 1_000_000_000;

type DelegationGrantDialogProps = {
  communityId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Dollars typed by the owner to integer nanoUSD; null when blank, NaN when unparseable. */
export function dollarsToNanoUsd(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const dollars = Number(trimmed.replace(/^\$/, ""));
  if (!Number.isFinite(dollars)) return Number.NaN;
  return Math.round(dollars * NANO_USD_PER_DOLLAR);
}

export function DelegationGrantDialog({
  communityId,
  open,
  onOpenChange,
}: DelegationGrantDialogProps) {
  const queryClient = useQueryClient();
  const [grantId, setGrantId] = React.useState("");
  const [category, setCategory] = React.useState("");
  const [scope, setScope] = React.useState("");
  const [capDollars, setCapDollars] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setGrantId("");
    setCategory("");
    setScope("");
    setCapDollars("");
  }, [open]);

  const capNanoUsd = open ? dollarsToNanoUsd(capDollars) : null;
  const problem = open
    ? delegationGrantDraftProblem({
        grantId,
        category,
        scope,
        capNanoUsd,
      })
    : null;

  const publishMutation = useMutation({
    mutationFn: async () =>
      publishDelegationGrant({ grantId, category, scope, capNanoUsd }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: delegationGrantsQueryKey(communityId),
      });
      onOpenChange(false);
    },
  });

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-lg" data-testid="delegation-grant-dialog">
        <DialogHeader>
          <DialogTitle>Delegate a decision</DialogTitle>
          <DialogDescription>
            A delegation belongs to the community, not to one agent: every
            leader and executive may decide under it. Signed by you, published
            as kind 30189.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="delegation-grant-id"
            >
              Delegation id
            </label>
            <Input
              data-testid="new-grant-id-input"
              id="delegation-grant-id"
              onChange={(event) => setGrantId(event.target.value)}
              placeholder="copy-blog-titles"
              value={grantId}
            />
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="delegation-category"
            >
              Category
            </label>
            <Input
              aria-invalid={
                category.trim().length > 0 &&
                problem?.includes("hard list") === true
              }
              data-testid="new-grant-category-input"
              id="delegation-category"
              onChange={(event) => setCategory(event.target.value)}
              placeholder="copy_change"
              value={category}
            />
            <p className="text-xs text-muted-foreground">
              Hard-list categories (spend, external_send, hiring, legal,
              pricing, deletion, vendor) can never be delegated.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="delegation-scope"
            >
              What this covers, in your words
            </label>
            <Input
              aria-invalid={problem?.includes("wildcard") === true}
              data-testid="new-grant-scope-input"
              id="delegation-scope"
              onChange={(event) => setScope(event.target.value)}
              placeholder="blog_post_titles"
              value={scope}
            />
            <p className="text-xs text-muted-foreground">
              This is an instruction the agent is asked to follow, not a fence
              anything holds it to. Nothing checks a decision against it, so
              read the decision log to see what was actually done. Be specific
              anyway: "all" and "*" are refused, because a delegation without a
              boundary is no policy at all.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              className="text-sm font-medium text-foreground"
              htmlFor="delegation-cap"
            >
              Most for one decision, in USD (optional)
            </label>
            <Input
              data-testid="new-grant-cap-input"
              id="delegation-cap"
              inputMode="decimal"
              onChange={(event) => setCapDollars(event.target.value)}
              placeholder="25.00"
              value={capDollars}
            />
            <p
              className="flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300"
              data-testid="new-grant-cap-warning"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                This is not a budget. It limits each decision on its own, so an
                agent can make one decision after another at this amount and
                nothing adds them up or stops it. The delegated authority list
                shows the running total, and revoking the delegation is what
                ends the spending.
              </span>
            </p>
          </div>

          {problem ? (
            <p
              className="text-sm text-destructive"
              data-testid="new-grant-problem"
              role="alert"
            >
              {problem}
            </p>
          ) : null}

          {publishMutation.error ? (
            <p
              className="text-sm text-destructive"
              data-testid="new-grant-relay-error"
              role="alert"
            >
              {(publishMutation.error as Error).message}
            </p>
          ) : null}

          <p className="text-xs text-muted-foreground">
            These checks only preview the relay's rules. The relay still
            decides, and its rejection is shown here verbatim.
          </p>
        </div>

        <DialogFooter>
          <Button
            onClick={() => onOpenChange(false)}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            data-testid="new-grant-submit"
            disabled={problem !== null || publishMutation.isPending}
            onClick={() => publishMutation.mutate()}
            type="button"
          >
            {publishMutation.isPending ? "Publishing..." : "Sign and publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
