import { SectionHeader } from "@/shared/ui/PageHeader";

import { formatNanousd } from "../contracts";
import { describeJobSpan, jobSpend } from "../jobSpend";
import type { LedgerReport } from "../report";

/**
 * What each job cost.
 *
 * `taskId` has been carried on every attributed entry for as long as
 * attribution has existed, and until now the screen dropped it before
 * rendering. So an owner could read that engineering spent $340 and never
 * that one Tuesday research job cost $2.10.
 *
 * The figures are the ledger's own, not an estimate: these are priced entries
 * from the engine, grouped. The only judgement here is what to do with an
 * unpriced call, and the answer is the same as everywhere else in this
 * feature: count it, never cost it at zero, and say the total is a floor.
 */

const JOB_LIMIT = 12;

export function LedgerByJob({ report }: { report: LedgerReport }) {
  const summary = jobSpend(report.entries);
  const shown = summary.jobs.slice(0, JOB_LIMIT);

  return (
    <section
      aria-label="Spend by job"
      className="rounded-2xl border border-border/60 bg-card/60 px-5 py-4"
      data-testid="ledger-by-job"
    >
      <SectionHeader
        description={
          summary.jobs.length > shown.length
            ? `The ${shown.length} most expensive of ${summary.jobs.length} jobs.`
            : "What each piece of work cost, from the calls attributed to it."
        }
        title="By job"
      />

      <div className="mt-4">
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No spend names a job yet. A job is recorded when an agent works
            under one, or when a rule or a correction assigns it, and until then
            spend can only be read by cost centre.
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {shown.map((job) => (
              <li
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
                data-testid={`ledger-job-${job.taskId}`}
                key={job.taskId}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {job.taskId}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {describeJobSpan(job)}
                    {" · "}
                    {job.callCount === 1 ? "1 call" : `${job.callCount} calls`}
                    {job.costCentreIds.length > 0
                      ? ` · ${job.costCentreIds.join(", ")}`
                      : null}
                    {job.clientOrganizationIds.length > 0
                      ? ` · for ${job.clientOrganizationIds.join(", ")}`
                      : null}
                  </p>
                </div>
                <p className="text-sm tabular-nums text-foreground">
                  {job.unpricedCallCount > 0 ? (
                    <span className="mr-1 text-xs font-normal text-muted-foreground">
                      at least
                    </span>
                  ) : null}
                  {formatNanousd(job.costNanousd)}
                </p>
              </li>
            ))}
          </ul>
        )}

        {summary.unassignedCallCount > 0 ? (
          <p
            className="mt-3 text-xs text-muted-foreground"
            data-testid="ledger-by-job-unassigned"
          >
            {summary.unassignedUnpricedCallCount > 0 ? "At least " : null}
            {formatNanousd(summary.unassignedNanousd)} of spend across{" "}
            {summary.unassignedCallCount === 1
              ? "1 call"
              : `${summary.unassignedCallCount} calls`}{" "}
            names no job, so it is not in this list. Attributing it, by rule or
            by correction, is what puts it here.
          </p>
        ) : null}
      </div>
    </section>
  );
}
