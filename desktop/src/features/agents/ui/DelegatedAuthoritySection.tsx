import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";

import {
  allGrantsFromEvents,
  delegationGrantsQueryKey,
  fetchDelegationGrantEvents,
} from "@/features/agents/delegationGrants";
import { revokeDelegationGrant } from "@/features/agents/delegationGrantActions";
import { useCommunityOwnersQuery } from "@/features/agents/communityOwners";
import type { DelegationGrant } from "@/features/agents/delegationGrants";
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
 */

const EMPTY_EVENTS: RelayEvent[] = [];
const EMPTY_OWNERS: ReadonlySet<string> = new Set();

/** Active grants first, then revoked; grant-id order inside each group. */
function orderedGrants(grants: readonly DelegationGrant[]): DelegationGrant[] {
  return [
    ...grants.filter((grant) => grant.active),
    ...grants.filter((grant) => !grant.active),
  ];
}

const ORDERED_EMPTY: DelegationGrant[] = [];

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

function grantSummaryLine(grant: DelegationGrant): string {
  const cap =
    grant.capNanoUsd !== null
      ? `capped at ${formatNanousdAsUsd(String(grant.capNanoUsd))}`
      : "no spending cap";
  return `${grant.category}, scope ${grant.scope}, ${cap}`;
}

function GrantRow({
  grant,
  onRevoke,
}: {
  grant: DelegationGrant;
  onRevoke: () => void;
}) {
  return (
    <div
      className={
        grant.active
          ? "flex items-center gap-3 rounded-xl border border-border/60 bg-background/60 px-4 py-3"
          : "flex items-center gap-3 rounded-xl border border-border/40 bg-transparent px-4 py-3 opacity-70"
      }
      data-testid={`grant-row-${grant.grantId}`}
    >
      <div className="min-w-0">
        <p className="truncate font-mono text-xs text-foreground">
          {grant.grantId}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {grantSummaryLine(grant)}
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
        relay and in this list.
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
