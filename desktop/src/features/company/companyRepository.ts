import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_COMPANY_PROFILE,
  KIND_INITIATIVE,
  KIND_TASK,
} from "@/shared/constants/kinds";

import type {
  CompanyParseResult,
  CompanyProfile,
  CompanyTask,
  Initiative,
  SubjectRef,
  TaskStatus,
} from "./contracts";
import {
  companyFailure,
  isTerminalTaskStatus,
  newestHead,
  normalizeHex,
  parseCompanyHead,
  parseInitiativeHead,
  parseTaskHead,
} from "./contracts";

/**
 * Reading a community's company records.
 *
 * Every query names its kinds and pins `authors` to the tenant relay signer,
 * because a head is only canonical if that key wrote it. Nothing here is
 * cached to disk: these are commercial records, and a company's task titles
 * outliving a community switch is a leak, not a performance win.
 */

const MAX_RECORDS = 500;

/**
 * Bumped by `resetCompanyRepositoryState()`. A read that started before a
 * community switch resolves after it, and must not deliver the old
 * community's records into the new one.
 */
let repositoryGeneration = 0;

export type CompanyRepositoryDependencies = {
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
  relaySelf: () => Promise<string | null>;
};

/**
 * How the Work surfaces narrow a task list.
 *
 * Every field here has an indexed single-letter mirror on the head (`c`
 * company, `i` initiative, `w` status, `g` team, `s` stage, `u` subject), so
 * each narrow compiles to a tag filter the relay can answer from its index.
 * The readable multi-letter tags (`initiative`, `team`, `cost-centre`) are
 * dropped by the nostr filter type before they reach a relay and must never
 * be queried.
 */
export type TaskQuery = {
  companyId?: string;
  initiativeId?: string;
  status?: TaskStatus;
  teamId?: string;
  stage?: string;
  subject?: SubjectRef;
};

export type ThreadTaskQuery = {
  /** Optional but recommended: scopes the scan through the company index. */
  companyId?: string;
  threadRoot: string;
};

/** The exact string build_head mirrors the subject into its `u` tag. */
function subjectMirrorKey(subject: SubjectRef): string {
  return `${subject.kind}:${subject.ref}`;
}

/**
 * The wire half of a task query: one indexed single-letter tag filter per
 * named narrow. Nostr ANDs distinct tag names, so combined narrows stay one
 * request.
 */
function taskQueryTagFilters(
  query: TaskQuery,
): Partial<Record<`#${string}`, string[]>> {
  const filters: Partial<Record<`#${string}`, string[]>> = {};
  if (query.companyId) filters["#c"] = [query.companyId];
  if (query.initiativeId) filters["#i"] = [query.initiativeId];
  if (query.status) filters["#w"] = [query.status];
  if (query.teamId) filters["#g"] = [query.teamId];
  if (query.stage) filters["#s"] = [query.stage];
  if (query.subject) filters["#u"] = [subjectMirrorKey(query.subject)];
  return filters;
}

/**
 * The result half of a task query, applied after parsing. A relay that
 * ignored (or predates) a mirror must not turn into silently wrong results:
 * what comes back is filtered again against the signed content itself.
 */
function taskMatchesQuery(task: CompanyTask, query: TaskQuery): boolean {
  return (
    (!query.companyId || task.companyId === query.companyId) &&
    (!query.initiativeId || task.initiativeId === query.initiativeId) &&
    (!query.status || task.status === query.status) &&
    (!query.teamId || task.owningTeamId === query.teamId) &&
    (!query.stage || task.stage === query.stage) &&
    (!query.subject ||
      (task.subject !== null &&
        task.subject.kind === query.subject.kind &&
        task.subject.ref === query.subject.ref))
  );
}

/** Live work above terminal work, newest update first within each band. */
function threadHistoryOrder(left: CompanyTask, right: CompanyTask): number {
  const liveDelta =
    Number(isTerminalTaskStatus(left.status)) -
    Number(isTerminalTaskStatus(right.status));
  if (liveDelta !== 0) return liveDelta;
  return right.updatedAt - left.updatedAt || left.id.localeCompare(right.id);
}

function unavailable<T>(error: unknown): CompanyParseResult<T> {
  return companyFailure<T>(
    "unavailable",
    `Company records could not be read: ${String(error)}`,
  );
}

export function createCompanyRepository(
  dependencies: CompanyRepositoryDependencies,
) {
  /**
   * One read: resolve the relay identity, query, and refuse to deliver a
   * result across a community switch.
   */
  async function read<T>(
    build: (relaySelfPubkey: string) => {
      kinds: number[];
      limit: number;
      authors?: string[];
    },
    collect: (
      events: RelayEvent[],
      relaySelfPubkey: string,
    ) => CompanyParseResult<T>,
  ): Promise<CompanyParseResult<T>> {
    const generation = repositoryGeneration;
    let relaySelfPubkey: string | null;
    try {
      relaySelfPubkey = await dependencies.relaySelf();
    } catch (error) {
      return unavailable<T>(error);
    }
    if (!relaySelfPubkey) {
      return companyFailure<T>(
        "no-relay-identity",
        "This community's relay has no stable identity, so it has no company records.",
      );
    }
    let events: RelayEvent[];
    try {
      events = await dependencies.fetchEvents(build(relaySelfPubkey));
    } catch (error) {
      return unavailable<T>(error);
    }
    if (generation !== repositoryGeneration) {
      return companyFailure<T>(
        "cancelled",
        "The company read was cancelled because the active community changed.",
      );
    }
    return collect(events, relaySelfPubkey);
  }

  /** Newest head per `d` coordinate, dropping anything that will not parse. */
  function collectHeads<T extends { id: string }>(
    events: RelayEvent[],
    relaySelfPubkey: string,
    parse: (
      event: RelayEvent,
      relaySelfPubkey: string,
    ) => CompanyParseResult<T>,
  ): T[] {
    const byCoordinate = new Map<string, RelayEvent>();
    for (const event of events) {
      const dTag = event.tags.find((tag) => tag[0] === "d" && tag.length === 2);
      const coordinate = dTag?.[1];
      if (coordinate === undefined) continue;
      const current = byCoordinate.get(coordinate);
      const winner = newestHead(current ? [current, event] : [event]);
      if (winner) byCoordinate.set(coordinate, winner);
    }
    const records: T[] = [];
    for (const event of byCoordinate.values()) {
      const parsed = parse(event, relaySelfPubkey);
      // A forged or malformed head sitting beside real ones is dropped rather
      // than failing the whole read; it must not appear either way.
      if (parsed.ok) records.push(parsed.value);
    }
    return records;
  }

  return {
    /**
     * The company this community operates as.
     *
     * A community has one. Rather than making every caller carry an ID it has
     * no way to know, this asks the relay which company it authored. When more
     * than one somehow exists, the oldest wins: that is the one the owner
     * approved first, and picking the newest would let a later stray record
     * quietly take over what work is charged to.
     */
    async getActiveCompany(): Promise<CompanyParseResult<CompanyProfile>> {
      return read<CompanyProfile>(
        (relaySelfPubkey) => ({
          kinds: [KIND_COMPANY_PROFILE],
          authors: [relaySelfPubkey],
          limit: 16,
        }),
        (events, relaySelfPubkey) => {
          const heads = collectHeads(events, relaySelfPubkey, parseCompanyHead);
          const company = heads.sort(
            (left, right) =>
              left.createdAt - right.createdAt ||
              left.id.localeCompare(right.id),
          )[0];
          return company
            ? { ok: true, value: company }
            : companyFailure<CompanyProfile>(
                "missing-head",
                "No company record exists on this community yet.",
              );
        },
      );
    },

    async getCompany(
      companyId: string,
    ): Promise<CompanyParseResult<CompanyProfile>> {
      return read<CompanyProfile>(
        (relaySelfPubkey) => ({
          kinds: [KIND_COMPANY_PROFILE],
          authors: [relaySelfPubkey],
          "#d": [companyId],
          limit: 8,
        }),
        (events, relaySelfPubkey) => {
          const heads = collectHeads(events, relaySelfPubkey, parseCompanyHead);
          const company = heads.find((record) => record.id === companyId);
          return company
            ? { ok: true, value: company }
            : companyFailure<CompanyProfile>(
                "missing-head",
                "No company record exists on this community yet.",
              );
        },
      );
    },

    async listInitiatives(
      companyId: string,
    ): Promise<CompanyParseResult<Initiative[]>> {
      return read<Initiative[]>(
        (relaySelfPubkey) => ({
          kinds: [KIND_INITIATIVE],
          authors: [relaySelfPubkey],
          "#c": [companyId],
          limit: MAX_RECORDS,
        }),
        (events, relaySelfPubkey) => ({
          ok: true,
          value: collectHeads(events, relaySelfPubkey, parseInitiativeHead)
            .filter((initiative) => initiative.companyId === companyId)
            .sort((left, right) => left.id.localeCompare(right.id)),
        }),
      );
    },

    async getInitiative(
      initiativeId: string,
    ): Promise<CompanyParseResult<Initiative>> {
      return read<Initiative>(
        (relaySelfPubkey) => ({
          kinds: [KIND_INITIATIVE],
          authors: [relaySelfPubkey],
          "#d": [initiativeId],
          limit: 8,
        }),
        (events, relaySelfPubkey) => {
          const initiative = collectHeads(
            events,
            relaySelfPubkey,
            parseInitiativeHead,
          ).find((record) => record.id === initiativeId);
          return initiative
            ? { ok: true, value: initiative }
            : companyFailure<Initiative>(
                "missing-head",
                "That initiative does not exist on this community.",
              );
        },
      );
    },

    async listTasks(
      query: TaskQuery,
    ): Promise<CompanyParseResult<CompanyTask[]>> {
      if (!query.companyId && !query.initiativeId) {
        return companyFailure<CompanyTask[]>(
          "invalid-record",
          "Listing tasks requires a company or an initiative.",
        );
      }
      return read<CompanyTask[]>(
        (relaySelfPubkey) => ({
          kinds: [KIND_TASK],
          authors: [relaySelfPubkey],
          ...taskQueryTagFilters(query),
          limit: MAX_RECORDS,
        }),
        (events, relaySelfPubkey) => ({
          ok: true,
          value: collectHeads(events, relaySelfPubkey, parseTaskHead)
            .filter((task) => taskMatchesQuery(task, query))
            .sort((left, right) => left.id.localeCompare(right.id)),
        }),
      );
    },

    /**
     * One thread's task history: newest live task first, earlier (terminal)
     * tasks after.
     *
     * `thread_root` is signed content, not a tag, so no indexed filter can
     * select it over the wire. The narrow happens here instead: this reads
     * task heads through the indexed `#c` mirror (or every head the tenant
     * relay authored when no company is named) and keeps those whose content
     * names the thread. Bounded by MAX_RECORDS — the 500 newest head events
     * are fetched, so in a company with more churn than that the oldest
     * tasks of quiet threads can fall off this view. A single-letter thread
     * mirror tag would move the narrow server-side; until one exists this is
     * the honest ceiling.
     */
    async listThreadTasks(
      query: ThreadTaskQuery,
    ): Promise<CompanyParseResult<CompanyTask[]>> {
      if (query.threadRoot.trim() === "") {
        return companyFailure<CompanyTask[]>(
          "invalid-record",
          "Listing a thread's tasks requires the thread root event id.",
        );
      }
      return read<CompanyTask[]>(
        (relaySelfPubkey) => ({
          kinds: [KIND_TASK],
          authors: [relaySelfPubkey],
          ...(query.companyId ? { "#c": [query.companyId] } : {}),
          limit: MAX_RECORDS,
        }),
        (events, relaySelfPubkey) => ({
          ok: true,
          value: collectHeads(events, relaySelfPubkey, parseTaskHead)
            .filter(
              (task) =>
                task.threadRoot !== null &&
                normalizeHex(task.threadRoot) ===
                  normalizeHex(query.threadRoot),
            )
            .sort(threadHistoryOrder),
        }),
      );
    },

    async getTask(taskId: string): Promise<CompanyParseResult<CompanyTask>> {
      return read<CompanyTask>(
        (relaySelfPubkey) => ({
          kinds: [KIND_TASK],
          authors: [relaySelfPubkey],
          "#d": [taskId],
          limit: 8,
        }),
        (events, relaySelfPubkey) => {
          const task = collectHeads(
            events,
            relaySelfPubkey,
            parseTaskHead,
          ).find((record) => record.id === taskId);
          return task
            ? { ok: true, value: task }
            : companyFailure<CompanyTask>(
                "missing-head",
                "That task does not exist on this community.",
              );
        },
      );
    },
  };
}

export type CompanyRepository = ReturnType<typeof createCompanyRepository>;

export const companyRepository = createCompanyRepository({
  fetchEvents: (filter) => relayClient.fetchEvents(filter),
  relaySelf: getRelaySelf,
});

/**
 * Wired into `resetCommunityState()`. There is no cache to clear; what this
 * invalidates is every read still in flight against the previous relay.
 */
export function resetCompanyRepositoryState(): void {
  repositoryGeneration += 1;
}
