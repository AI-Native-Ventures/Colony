import { rankLabel, type AgentRank } from "@/features/agents/employeeHeads";
import type { DelegationGrant } from "@/features/agents/delegationGrants";
import { formatNanousdAsUsd } from "@/shared/api/tauriProvisionedCredits";
import { Checkbox } from "@/shared/ui/checkbox";

/**
 * What a promotion confers, and the acknowledgement that gates it.
 *
 * Delegation grants are community-wide: a grant has no holder, and authority
 * resolves on rank alone, so moving an agent to leader or above hands it
 * every active grant immediately. Any surface that can promote has to state
 * that and make the owner tick a box first, which is why this lives in one
 * component rather than once per dialog.
 */

/** Grants shown individually before the summary count takes over. */
const MAX_LISTED_GRANTS = 4;

export function PromotionGrantWarning({
  acknowledged,
  grants,
  isGrantsLoading,
  name,
  onAcknowledgedChange,
  rank,
  verb,
}: {
  acknowledged: boolean;
  /** Every currently active grant in the community. */
  grants: readonly DelegationGrant[];
  isGrantsLoading: boolean;
  /** The agent being promoted. */
  name: string;
  onAcknowledgedChange: (acknowledged: boolean) => void;
  /** The rank being moved to; null while none is selected. */
  rank: AgentRank | null;
  /** "Promoting" for a move up an existing ladder, "Assigning" for a first rank. */
  verb: "Assigning" | "Promoting";
}) {
  return (
    <div
      className="space-y-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3"
      data-testid="promotion-grant-warning"
    >
      <p className="text-sm font-medium text-foreground">
        {verb} {name} to {rank ? rankLabel(rank) : ""} gives it every active
        delegation in this community, immediately. Delegations belong to the
        community, not to one agent: any leader or executive may decide under
        them.
      </p>
      {isGrantsLoading ? (
        <p className="text-xs text-muted-foreground">
          Checking active delegations...
        </p>
      ) : grants.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="promotion-no-grants"
        >
          No delegations are currently active, so this grants no autonomous
          spending authority.
        </p>
      ) : (
        <div className="space-y-1.5">
          {grants.slice(0, MAX_LISTED_GRANTS).map((grant) => (
            <p
              className="text-xs text-foreground"
              data-testid={`promotion-grant-${grant.grantId}`}
              key={grant.grantId}
            >
              <span className="font-medium">{grant.category}</span> scope{" "}
              {grant.scope}
              {grant.capNanoUsd !== null
                ? `, capped at ${formatNanousdAsUsd(String(grant.capNanoUsd))}`
                : ", no spending cap"}
            </p>
          ))}
          {grants.length > MAX_LISTED_GRANTS ? (
            <p className="text-xs text-muted-foreground">
              ...and {grants.length - MAX_LISTED_GRANTS} more active{" "}
              {grants.length - MAX_LISTED_GRANTS === 1
                ? "delegation"
                : "delegations"}
              .
            </p>
          ) : null}
        </div>
      )}
      {isGrantsLoading ? null : (
        <div className="flex items-start gap-2 text-sm text-foreground">
          <Checkbox
            checked={acknowledged}
            data-testid="promotion-acknowledge-checkbox"
            id="promotion-acknowledge"
            onCheckedChange={(checked) => {
              onAcknowledgedChange(checked === true);
            }}
          />
          <label htmlFor="promotion-acknowledge">
            I understand what this promotion confers.
          </label>
        </div>
      )}
    </div>
  );
}
