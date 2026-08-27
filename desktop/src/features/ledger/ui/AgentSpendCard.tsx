import * as React from "react";

import { Skeleton } from "@/shared/ui/skeleton";

import { SPEND_PERIODS, type SpendPeriod } from "../agentSpend";
import { formatNanousd } from "../contracts";
import { useAgentSpend } from "../hooks";
import { unpricedModelExplanation } from "../report";
import { SpendPeriodPicker } from "./SpendPeriodPicker";

/**
 * What one agent has cost, on the agent's own page.
 *
 * The Spend screen answers this for the whole roster once a week. A person
 * deciding whether to keep an agent running, give it more work, or move it to
 * a cheaper model is standing on that agent's profile, and the figure has to
 * be there rather than two screens away.
 *
 * Self-contained on purpose: it takes a pubkey and a community and fetches
 * its own data, so mounting it anywhere is one line and no host screen has to
 * learn anything about pricing.
 */

const HEADLINE_MODEL_LIMIT = 3;

function Figure({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-2xl font-semibold tracking-tight tabular-nums text-foreground">
      {children}
    </p>
  );
}

export function AgentSpendCard({
  agentPubkey,
  className,
  communityId,
}: {
  /** 64-hex pubkey of the agent whose cost to show. */
  agentPubkey: string;
  className?: string;
  /** Active community id; the figure is scoped to it like every other read. */
  communityId: string;
}) {
  const [period, setPeriod] = React.useState<SpendPeriod>(
    SPEND_PERIODS[0] as SpendPeriod,
  );
  const { collectionEnabled, error, isLoading, spend } = useAgentSpend(
    communityId,
    period.days,
    agentPubkey,
  );

  const agent = spend?.agents.find(
    (candidate) => candidate.agentPubkey === agentPubkey.toLowerCase(),
  );
  const isFloor = (agent?.unpricedModels.length ?? 0) > 0;

  return (
    <section
      aria-label="What this agent has cost"
      className={
        className ?? "rounded-2xl border border-border/60 bg-card/60 px-5 py-4"
      }
      data-testid="agent-spend-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <p className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          What this agent has cost
        </p>
        <SpendPeriodPicker onChange={setPeriod} value={period} />
      </div>

      <div className="mt-3">
        {isLoading ? (
          <div aria-busy="true" aria-label="Working it out" role="status">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="mt-2 h-3 w-44" />
          </div>
        ) : null}

        {!isLoading && error ? (
          <div role="alert">
            {/* Never $0.00 for a read that failed. A reassuring zero is the
                worst thing this card could say. */}
            <Figure>Unknown</Figure>
            <p className="mt-1 text-xs text-muted-foreground">
              {error.message} Nothing is shown rather than a figure that might
              be wrong.
            </p>
          </div>
        ) : null}

        {!isLoading && !error && !collectionEnabled ? (
          <div>
            <Figure>Not recorded</Figure>
            <p className="mt-1 text-xs text-muted-foreground">
              Agent turn metrics are not archived on this machine, so this
              agent&apos;s work has nothing to price. Turn on the local archive
              in Settings.
            </p>
          </div>
        ) : null}

        {!isLoading && !error && collectionEnabled && spend ? (
          agent === undefined ? (
            <div>
              <Figure>No recorded work</Figure>
              <p className="mt-1 text-xs text-muted-foreground">
                This agent did nothing in this period that reached the archive.
              </p>
            </div>
          ) : spend.priceBookMissing ? (
            <div>
              {/* A missing book is not a zero. Every model this agent ran is
                  unpriced, so "at least $0.00" would dress an absence up as
                  a floor. The sibling card on the Spend screen says the same
                  thing in the same words. */}
              <Figure>Not priced</Figure>
              <p className="mt-1 text-xs text-muted-foreground">
                No prices have been published, so none of this agent&apos;s
                recorded work can be costed. The tokens are saved and become
                countable the moment a rate exists.
              </p>
            </div>
          ) : (
            <div>
              <Figure>
                {isFloor ? (
                  <span className="mr-1 text-sm font-normal text-muted-foreground">
                    at least
                  </span>
                ) : null}
                {formatNanousd(agent.costNanousd)}
              </Figure>
              <p className="mt-1 text-xs text-muted-foreground">
                {period.label.toLowerCase()}
                {agent.reportCount > 0
                  ? `, over ${agent.reportCount === 1 ? "1 turn" : `${agent.reportCount} turns`}`
                  : null}
                {". "}
                Estimated from archived turn metrics at published rates.
              </p>
              {isFloor ? (
                <p
                  className="mt-1 text-xs text-muted-foreground"
                  data-testid="agent-spend-unpriced"
                >
                  {unpricedModelExplanation(agent.unpricedModels[0] ?? null)}
                </p>
              ) : null}
              {agent.models.length > 0 ? (
                <ul className="mt-3 space-y-1">
                  {agent.models.slice(0, HEADLINE_MODEL_LIMIT).map((model) => (
                    <li
                      className="flex items-baseline justify-between gap-3 text-xs"
                      // The archive groups a window's turns by harness and
                      // model, so the pair is unique within one agent.
                      key={`${model.model ?? "unnamed"}:${model.harness ?? "unknown"}`}
                    >
                      <span className="min-w-0 truncate text-muted-foreground">
                        {model.model ?? "Model not named"}
                      </span>
                      <span className="shrink-0 tabular-nums text-foreground">
                        {model.costNanousd === null
                          ? "not priced"
                          : formatNanousd(model.costNanousd)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )
        ) : null}
      </div>
    </section>
  );
}
