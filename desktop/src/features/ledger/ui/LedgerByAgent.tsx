import { Bot } from "lucide-react";

import { useUsersBatchQuery } from "@/features/profile/hooks";
import { resolveUserLabel } from "@/features/profile/lib/identity";
import { Button } from "@/shared/ui/button";
import { SectionHeader } from "@/shared/ui/PageHeader";
import { Skeleton } from "@/shared/ui/skeleton";
import { UserAvatar } from "@/shared/ui/UserAvatar";

import type { AgentSpend, SpendPeriod, UsageSpend } from "../agentSpend";
import { formatNanousd } from "../contracts";
import { unpricedModelExplanation } from "../report";
import { SpendPeriodPicker } from "./SpendPeriodPicker";

/**
 * What each agent cost.
 *
 * The company total answers "are we spending too much"; this answers "on
 * what". It is the first screen in Colony that can name an individual agent
 * and a dollar figure in the same line.
 *
 * It is scrupulous about what it is. The figures come from turn metrics this
 * machine archived, priced against the published book, so they are an
 * estimate and never the ledger's own metered spend. Where the estimate is
 * incomplete, the row says so in words rather than rounding the doubt away:
 * a model with no rate on file makes the agent's figure a floor, and the
 * floor is labelled "at least".
 */

function Loading() {
  return (
    <div aria-busy="true" aria-label="Working out agent spend" role="status">
      <ul className="space-y-3">
        {[0, 1, 2].map((index) => (
          <li className="flex items-center gap-3" key={index}>
            <Skeleton className="size-8 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="mt-2 h-3 w-48" />
            </div>
            <Skeleton className="h-4 w-16 shrink-0" />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What a row's per-model detail says, in one line. */
function modelSummary(agent: AgentSpend): string {
  const named = agent.models
    .filter((model) => model.model !== null)
    .map((model) => model.model as string);
  if (named.length === 0) return "No model was named on these turns.";
  if (named.length <= 2) return named.join(", ");
  return `${named.slice(0, 2).join(", ")} and ${named.length - 2} more`;
}

function Row({
  agent,
  avatarUrl,
  name,
}: {
  agent: AgentSpend;
  avatarUrl: string | null;
  name: string;
}) {
  const isFloor = agent.unpricedModels.length > 0;
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
      data-testid={`ledger-agent-row-${agent.agentPubkey}`}
    >
      <UserAvatar avatarUrl={avatarUrl} displayName={name} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {modelSummary(agent)}
        </p>
      </div>
      <div className="text-right">
        <p className="text-sm tabular-nums text-foreground">
          {isFloor ? (
            <span className="mr-1 text-xs font-normal text-muted-foreground">
              at least
            </span>
          ) : null}
          {formatNanousd(agent.costNanousd)}
        </p>
        {isFloor ? (
          <p className="text-2xs text-muted-foreground">
            {unpricedModelExplanation(agent.unpricedModels[0] ?? null)}
          </p>
        ) : null}
      </div>
    </li>
  );
}

export function LedgerByAgent({
  error,
  isLoading,
  collectionEnabled,
  onAddPrice,
  onPeriodChange,
  period,
  spend,
}: {
  error: Error | null;
  isLoading: boolean;
  /** False when kind 44200 archiving is switched off for this identity. */
  collectionEnabled: boolean;
  /** Absent when the viewer cannot publish prices. */
  onAddPrice?: () => void;
  onPeriodChange: (period: SpendPeriod) => void;
  period: SpendPeriod;
  /** Null while loading or on failure. Never rendered as zero. */
  spend: UsageSpend | null;
}) {
  const pubkeys = spend?.agents.map((agent) => agent.agentPubkey) ?? [];
  const profilesQuery = useUsersBatchQuery(pubkeys);
  const profiles = profilesQuery.data?.profiles;

  return (
    <section
      aria-label="Spend by agent"
      className="rounded-2xl border border-border/60 bg-card/60 px-5 py-4"
      data-testid="ledger-by-agent"
    >
      <SectionHeader
        action={<SpendPeriodPicker onChange={onPeriodChange} value={period} />}
        description="Estimated from the turn metrics this machine archived, priced at the rates in the book. Not the same figure as the metered totals above, which come from the providers."
        title="By agent"
      />

      <div className="mt-4">
        {isLoading ? <Loading /> : null}

        {!isLoading && error ? (
          <div
            className="rounded-xl border border-destructive/25 bg-destructive/5 px-4 py-3"
            role="alert"
          >
            <p className="text-sm font-semibold text-foreground">
              Agent spend could not be worked out
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {error.message} Nothing is shown rather than a figure that might
              be wrong.
            </p>
          </div>
        ) : null}

        {!isLoading && !error && !collectionEnabled ? (
          <p className="text-sm text-muted-foreground">
            Agent turn metrics are not being archived on this machine, so there
            is nothing to price. Turn on the local archive in Settings and
            figures appear as agents work.
          </p>
        ) : null}

        {!isLoading && !error && collectionEnabled && spend ? (
          spend.agents.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center">
              <Bot
                aria-hidden="true"
                className="mx-auto size-6 text-muted-foreground"
              />
              <p className="mt-2 text-sm text-muted-foreground">
                No agent did any recorded work in this period.
              </p>
            </div>
          ) : (
            <>
              <ul className="divide-y divide-border/50">
                {spend.agents.map((agent) => (
                  <Row
                    agent={agent}
                    avatarUrl={profiles?.[agent.agentPubkey]?.avatarUrl ?? null}
                    key={agent.agentPubkey}
                    name={resolveUserLabel({
                      preferResolvedSelfLabel: true,
                      profiles,
                      pubkey: agent.agentPubkey,
                    })}
                  />
                ))}
              </ul>

              {spend.priceBookMissing ? (
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    No prices have been published, so none of this work can be
                    costed. The tokens are recorded and become countable the
                    moment a rate exists, with nothing to re-record.
                  </p>
                  {onAddPrice ? (
                    <Button
                      className="h-auto px-2 py-1 text-xs"
                      data-testid="ledger-by-agent-add-price"
                      onClick={onAddPrice}
                      type="button"
                      variant="outline"
                    >
                      Add a price
                    </Button>
                  ) : null}
                </div>
              ) : null}

              {spend.hasEstimatedSplit ? (
                <p
                  className="mt-3 text-xs text-muted-foreground"
                  data-testid="ledger-by-agent-split-note"
                >
                  Some turns reported a total input count without saying how
                  much of it was served from cache. Those tokens are priced at
                  the uncached rate, which can read high or low depending on
                  what the cache actually did.
                </p>
              ) : null}

              {spend.hasUnreadableUsage ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Some turns did not report enough to be priced at all. They are
                  missing from these figures rather than counted as free.
                </p>
              ) : null}
            </>
          )
        ) : null}
      </div>
    </section>
  );
}
