import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ScrollText } from "lucide-react";

import {
  allGrantsFromEvents,
  delegationGrantsQueryKey,
  fetchDelegationGrantEvents,
} from "@/features/agents/delegationGrants";
import { revokeDelegationGrant } from "@/features/agents/delegationGrantActions";
import { useCommunityOwnersQuery } from "@/features/agents/communityOwners";
import type { DelegationGrant } from "@/features/agents/delegationGrants";
import { decisionLogsFromEvents } from "@/features/asks/lib/decisionLog";
import {
  grantSpendFor,
  grantSpendTotals,
  NO_GRANT_SPEND,
  type GrantSpend,
} from "@/features/asks/lib/grantSpend";
import { useDecisionLogEventsQuery } from "@/features/asks/useDecisionLogEvents";
import { formatNanousdAsUsd } from "@/shared/api/tauriProvisionedCredits";
import type { RelayEvent } from "@/shared/api/types";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { SectionHeader } from "@/shared/ui/PageHeader";
import { DelegationGrantDialog } from "./DelegationGrantDialog";

/**
 * The community's delegation grants: every head a current owner ever
 * authored at its `d` tag, revoked ones included.
 *
 * A grant has no holder. Authority resolves on rank alone -- any leader or
 * executive may decide under an active grant -- so this surface lists what
 * the community has delegated, never who. Revocation republishes the same
 * `d` tag with `active: false`; the record stays on the relay and stays
 * listed here, because a revoked grant is part of the owner's record, not a
 * deletion.
 *
 * Each row carries two money figures side by side because one is meaningless
 * without the other. A grant's cap is a ceiling on ONE decision: the relay
 * checks each decision against it in isolation and never sums what came
 * before, so a capped grant places no bound on the total. The running total
 * is computed here from the decision log (kind 44303) and shown next to the
 * ceiling, so a per-decision limit cannot be mistaken for a budget.
 */

const EMPTY_EVENTS: RelayEvent[] = [];
const EMPTY_OWNERS: ReadonlySet<string> = new Set();

/** Whether the running totals can be trusted on screen yet. */
type SpendState = "loading" | "ready" | "unavailable";

/** Active grants first, then revoked; grant-id order inside each group. */
function orderedGrants(grants: readonly DelegationGrant[]): DelegationGrant[] {
  return [
    ...grants.filter((grant) => grant.active),
    ...grants.filter((grant) => !grant.active),
  ];
}

const ORDERED_EMPTY: DelegationGrant[] = [];
const EMPTY_SPEND: ReadonlyMap<string, GrantSpend> = new Map();

export function DelegatedAuthoritySection({
  communityId,
}: {
  communityId: string;
}) {
  const queryClient = useQueryClient();
  const ownersQuery = useCommunityOwnersQuery(communityId);
  const grantEventsQuery = useQuery({
    queryKey: delegationGrantsQueryKey(communityId),
    queryFn: fetchDelegationGrantEvents,
    enabled: communityId !== "",
    staleTime: 30_000,
  });
  // Same query key the decision log dialog uses, so the two surfaces share
  // one fetch and can never disagree about what was decided.
  const decisionEventsQuery = useDecisionLogEventsQuery({ communityId });

  const [isCreateOpen, setIsCreateOpen] = React.useState(false);
  const [confirmingRevokeId, setConfirmingRevokeId] = React.useState<
    string | null
  >(null);

  const grants = React.useMemo(
    () =>
      allGrantsFromEvents(
        grantEventsQuery.data ?? EMPTY_EVENTS,
        ownersQuery.data ?? EMPTY_OWNERS,
      ),
    [grantEventsQuery.data, ownersQuery.data],
  );
  // Hoisted so a no-grants render reuses one array identity.
  const displayGrants =
    grants.length > 0 ? orderedGrants(grants) : ORDERED_EMPTY;

  const spendByGrant = React.useMemo(
    () =>
      decisionEventsQuery.data === undefined
        ? EMPTY_SPEND
        : grantSpendTotals(decisionLogsFromEvents(decisionEventsQuery.data)),
    [decisionEventsQuery.data],
  );
  const spendState: SpendState = decisionEventsQuery.isError
    ? "unavailable"
    : decisionEventsQuery.data === undefined
      ? "loading"
      : "ready";

  const invalidateGrants = React.useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: delegationGrantsQueryKey(communityId),
    });
  }, [communityId, queryClient]);

  const revokeMutation = useMutation({
    mutationFn: revokeDelegationGrant,
    onSuccess: async () => {
      setConfirmingRevokeId(null);
      await invalidateGrants();
    },
  });

  const isLoading = ownersQuery.isLoading || grantEventsQuery.isLoading;
  const revokeError = revokeMutation.error as Error | null;

  return (
    <section
      className="rounded-2xl border border-border/60 bg-muted/20 p-4"
      data-testid="delegated-authority-section"
    >
      <SectionHeader
        action={
          <Button
            data-testid="new-delegation-button"
            disabled={communityId === ""}
            onClick={() => setIsCreateOpen(true)}
            size="sm"
            variant="outline"
          >
            <ScrollText />
            Delegate a decision
          </Button>
        }
        description="Delegations belong to this community, not to one agent: every leader and executive may decide under them."
        title="Delegated authority"
      />

      {isLoading ? (
        <div
          className="mt-3 h-10 animate-pulse rounded-xl bg-muted/40"
          data-testid="delegated-authority-loading"
        />
      ) : displayGrants.length === 0 ? (
        <p
          className="mt-3 text-sm text-muted-foreground"
          data-testid="delegated-authority-empty"
        >
          Nothing is delegated yet. Agents escalate every decision to you.
        </p>
      ) : (
        <div className="mt-3 space-y-2" data-testid="delegation-grant-list">
          {displayGrants.map((grant) =>
            confirmingRevokeId === grant.grantId ? (
              <GrantRevokeConfirm
                error={revokeError}
                grant={grant}
                isPending={revokeMutation.isPending}
                key={grant.grantId}
                onCancel={() => setConfirmingRevokeId(null)}
                onConfirm={() => revokeMutation.mutate(grant)}
              />
            ) : (
              <GrantRow
                grant={grant}
                key={grant.grantId}
                onRevoke={() => {
                  setConfirmingRevokeId(grant.grantId);
                }}
                spend={grantSpendFor(spendByGrant, grant.grantId)}
                spendState={spendState}
              />
            ),
          )}
        </div>
      )}

      <DelegationGrantDialog
        communityId={communityId}
        onOpenChange={setIsCreateOpen}
        open={isCreateOpen}
      />
    </section>
  );
}

/** The ceiling on any single decision, in the owner's own words. */
function capLabel(grant: DelegationGrant): string {
  return grant.capNanoUsd !== null
    ? formatNanousdAsUsd(String(grant.capNanoUsd))
    : "No limit set";
}

function decisionCountLabel(count: number): string {
  if (count === 0) return "No decisions yet";
  return count === 1 ? "1 decision" : `${count} decisions`;
}

/**
 * Cap and running total, in one formatter so the owner can read them
 * against each other. Both are integer nanoUSD; the total is summed as a
 * bigint and only becomes a string at the last step.
 */
function GrantMoney({
  grant,
  spend,
  spendState,
}: {
  grant: DelegationGrant;
  spend: GrantSpend;
  spendState: SpendState;
}) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-x-4 border-t border-border/40 pt-3">
      <div className="min-w-0">
        <dt className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Most for one decision
        </dt>
        <dd
          className="mt-0.5 text-sm tabular-nums text-foreground"
          data-testid={`grant-cap-${grant.grantId}`}
        >
          {capLabel(grant)}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {grant.active ? "Spent so far" : "Spent while it was live"}
        </dt>
        {spendState === "loading" ? (
          <dd
            className="mt-0.5 text-sm text-muted-foreground"
            data-testid={`grant-spent-${grant.grantId}`}
          >
            Adding it up...
          </dd>
        ) : spendState === "unavailable" ? (
          <>
            <dd
              className="mt-0.5 text-sm text-muted-foreground"
              data-testid={`grant-spent-${grant.grantId}`}
            >
              Unknown
            </dd>
            <dd className="text-2xs text-muted-foreground">
              The decision log did not load.
            </dd>
          </>
        ) : (
          <>
            <dd
              className="mt-0.5 text-sm tabular-nums text-foreground"
              data-testid={`grant-spent-${grant.grantId}`}
            >
              {formatNanousdAsUsd(spend.totalNanoUsd.toString())}
            </dd>
            <dd
              className="text-2xs text-muted-foreground"
              data-testid={`grant-decision-count-${grant.grantId}`}
            >
              {decisionCountLabel(spend.decisionCount)}
            </dd>
          </>
        )}
      </div>
    </dl>
  );
}

function GrantRow({
  grant,
  onRevoke,
  spend = NO_GRANT_SPEND,
  spendState = "ready",
}: {
  grant: DelegationGrant;
  onRevoke: () => void;
  spend?: GrantSpend;
  spendState?: SpendState;
}) {
  return (
    <div
      className={
        grant.active
          ? "rounded-xl border border-border/60 bg-background/60 px-4 py-3"
          : "rounded-xl border border-border/40 bg-transparent px-4 py-3 opacity-70"
      }
      data-testid={`grant-row-${grant.grantId}`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-xs text-foreground">
            {grant.grantId}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Covers {grant.category} decisions.
          </p>
        </div>
        <Badge
          data-testid={`grant-status-${grant.grantId}`}
          variant={grant.active ? "success" : "outline"}
          className="ml-auto shrink-0"
        >
          {grant.active ? "Active" : "Revoked"}
        </Badge>
        {grant.active ? (
          <Button
            data-testid={`grant-revoke-${grant.grantId}`}
            onClick={onRevoke}
            size="sm"
            variant="ghost"
          >
            Revoke
          </Button>
        ) : null}
      </div>

      {/* Scope is an instruction the agent is asked to follow, not a fence
          anything enforces, so it is worded as one. */}
      <p
        className="mt-2 break-words text-xs text-muted-foreground"
        data-testid={`grant-scope-${grant.grantId}`}
      >
        <span className="text-foreground">Told to stick to:</span> {grant.scope}
        . Nothing checks a decision against that, so the decision log is how you
        find out.
      </p>

      <GrantMoney grant={grant} spend={spend} spendState={spendState} />

      {!grant.active ? (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid={`grant-history-note-${grant.grantId}`}
        >
          Revoked, so nothing new can be decided under it. What is above is what
          it cost while it was live.
        </p>
      ) : grant.capNanoUsd !== null ? (
        <p
          className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-300"
          data-testid={`grant-cap-note-${grant.grantId}`}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            That limit is per decision, not a budget. Agents can keep deciding
            at or under it and nothing stops the total growing. Revoke this
            delegation if the spending gets away from you.
          </span>
        </p>
      ) : (
        <p
          className="mt-2 text-xs text-muted-foreground"
          data-testid={`grant-cap-note-${grant.grantId}`}
        >
          No money limit was set, so nothing checks the size of a decision made
          under this delegation.
        </p>
      )}
    </div>
  );
}

function GrantRevokeConfirm({
  grant,
  onCancel,
  onConfirm,
  isPending,
  error,
}: {
  grant: DelegationGrant;
  onCancel: () => void;
  onConfirm: () => void;
  isPending: boolean;
  error: Error | null;
}) {
  return (
    <div
      className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3"
      data-testid={`grant-revoke-confirm-${grant.grantId}`}
    >
      <p className="text-sm font-medium text-foreground">
        Revoke {grant.grantId}?
      </p>
      <p className="text-xs text-muted-foreground">
        Republishes this delegation with active: false at the same id. Leaders
        and executives lose the authority immediately; the record stays on the
        relay and in this list, along with what was decided under it.
      </p>
      {error ? (
        <p
          className="text-sm text-destructive"
          data-testid={`grant-revoke-error-${grant.grantId}`}
          role="alert"
        >
          {error.message}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button
          data-testid={`grant-revoke-cancel-${grant.grantId}`}
          onClick={onCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          Keep
        </Button>
        <Button
          data-testid={`grant-revoke-submit-${grant.grantId}`}
          disabled={isPending}
          onClick={onConfirm}
          size="sm"
          type="button"
          variant="destructive"
        >
          {isPending ? "Revoking..." : "Sign revocation"}
        </Button>
      </div>
    </div>
  );
}
