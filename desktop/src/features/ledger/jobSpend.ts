import type { LedgerEntry } from "./report";

/**
 * What one job cost.
 *
 * `taskId` has travelled the whole length of this system for as long as
 * attribution has existed. A rule can assign it, a correction can set it, the
 * engine carries it on every priced entry inside `effectiveAssignment`, and
 * the Spend screen then threw it away: it grouped by cost centre and listed
 * by model, so an owner could learn that engineering spent $340 and never
 * that one Tuesday research job cost $2.10.
 *
 * That second sentence is the one this module exists to make sayable. It is
 * arithmetic over entries the ledger already priced, so it inherits the
 * engine's money exactly, in `bigint` nanoUSD, and adds nothing of its own.
 */

/** Everything one job cost, and what it was. */
export interface JobSpend {
  /** The job's identifier, as attribution recorded it. */
  taskId: string;
  /**
   * Sum of the priced calls, in nanoUSD.
   *
   * A floor, not a total, when `unpricedCallCount` is above zero: an
   * unpriced call is real work whose rate is not on file, and adding it in
   * as zero would understate the job while looking complete.
   */
  costNanousd: bigint;
  /** Calls recorded against this job. */
  callCount: number;
  /** Of those, how many had no price and so are not in the figure. */
  unpricedCallCount: number;
  /** Cost centres this job's calls were charged to, sorted. */
  costCentreIds: string[];
  /** Client organizations the work was for, sorted; empty for internal work. */
  clientOrganizationIds: string[];
  /** Models the job used, sorted. */
  models: string[];
  /** Earliest UTC day of the job's calls, `YYYY-MM-DD`. */
  firstDay: string;
  /** Latest UTC day of the job's calls, `YYYY-MM-DD`. */
  lastDay: string;
}

/** Jobs, plus the spend that named no job at all. */
export interface JobSpendSummary {
  /** Jobs, most expensive first. */
  jobs: JobSpend[];
  /** Calls carrying no job identifier. */
  unassignedCallCount: number;
  /**
   * Of those, how many had no price and so are not in the figure.
   *
   * While this is above zero the unassigned amount is a floor, not a total:
   * unpriced calls are real work whose cost is simply not on file, and the
   * footnote has to say so rather than let a missing rate read as free.
   */
  unassignedUnpricedCallCount: number;
  /**
   * What those calls cost, in nanoUSD.
   *
   * Reported rather than hidden. A jobs list that silently covered a third
   * of the bill would be read as the whole bill.
   */
  unassignedNanousd: bigint;
}

/** Mutable accumulator; the public shape is frozen arrays. */
interface Accumulator {
  taskId: string;
  costNanousd: bigint;
  callCount: number;
  unpricedCallCount: number;
  costCentreIds: Set<string>;
  clientOrganizationIds: Set<string>;
  models: Set<string>;
  firstDay: string;
  lastDay: string;
}

/**
 * Group priced entries by the job they belonged to.
 *
 * Entries with no assignment, or an assignment carrying no `taskId`, are not
 * invented into a job; they are counted separately so the page can say how
 * much of the bill is not job-attributed rather than quietly dropping it.
 */
export function jobSpend(entries: readonly LedgerEntry[]): JobSpendSummary {
  const jobs = new Map<string, Accumulator>();
  let unassignedCallCount = 0;
  let unassignedUnpricedCallCount = 0;
  let unassignedNanousd = 0n;

  for (const entry of entries) {
    const taskId = entry.effectiveAssignment?.taskId ?? null;
    if (taskId === null || taskId.trim() === "") {
      unassignedCallCount += 1;
      if (entry.costNanousd === null) {
        unassignedUnpricedCallCount += 1;
      } else {
        unassignedNanousd += entry.costNanousd;
      }
      continue;
    }

    let job = jobs.get(taskId);
    if (!job) {
      job = {
        callCount: 0,
        clientOrganizationIds: new Set<string>(),
        costCentreIds: new Set<string>(),
        costNanousd: 0n,
        firstDay: entry.day,
        lastDay: entry.day,
        models: new Set<string>(),
        taskId,
        unpricedCallCount: 0,
      };
      jobs.set(taskId, job);
    }

    job.callCount += 1;
    if (entry.costNanousd === null) {
      job.unpricedCallCount += 1;
    } else {
      job.costNanousd += entry.costNanousd;
    }
    if (entry.effectiveAssignment) {
      job.costCentreIds.add(entry.effectiveAssignment.costCentreId);
      const client = entry.effectiveAssignment.clientOrganizationId;
      if (client) job.clientOrganizationIds.add(client);
    }
    if (entry.model) job.models.add(entry.model);
    if (entry.day < job.firstDay) job.firstDay = entry.day;
    if (entry.day > job.lastDay) job.lastDay = entry.day;
  }

  return {
    jobs: [...jobs.values()]
      .map((job) => ({
        callCount: job.callCount,
        clientOrganizationIds: [...job.clientOrganizationIds].sort(),
        costCentreIds: [...job.costCentreIds].sort(),
        costNanousd: job.costNanousd,
        firstDay: job.firstDay,
        lastDay: job.lastDay,
        models: [...job.models].sort(),
        taskId: job.taskId,
        unpricedCallCount: job.unpricedCallCount,
      }))
      .sort((left, right) => {
        if (left.costNanousd === right.costNanousd) {
          return left.taskId.localeCompare(right.taskId);
        }
        return left.costNanousd > right.costNanousd ? -1 : 1;
      }),
    unassignedCallCount,
    unassignedNanousd,
    unassignedUnpricedCallCount,
  };
}

/**
 * How long a job ran, in the words a person uses.
 *
 * A job that started and finished on one day says that day; anything else
 * says both ends. Formatting the same day twice reads as a bug.
 */
export function describeJobSpan(job: JobSpend): string {
  return job.firstDay === job.lastDay
    ? job.firstDay
    : `${job.firstDay} to ${job.lastDay}`;
}
