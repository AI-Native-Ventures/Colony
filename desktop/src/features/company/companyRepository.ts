import { getRelaySelf } from "@/features/moderation/lib/relaySelf";
import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import {
  KIND_COHORT,
  KIND_COMPANY_PROFILE,
  KIND_INITIATIVE,
  KIND_TASK,
} from "@/shared/constants/kinds";

import type {
  Cohort,
  CompanyParseResult,
  CompanyProfile,
  CompanyTask,
  Initiative,
  SubjectRef,
  TaskStatus,
} from "./contracts";
import {
  COMMUNITY_PROFILE_ID,
  companyFailure,
  isTerminalTaskStatus,
  newestHead,
  normalizeHex,
  parseCohortHead,
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
  delay?: (ms: number) => Promise<void>;
  taskReadBackAttempts?: number;
  taskReadBackIntervalMs?: number;
};

/**
 * How long a Task read-back retries before giving up.
 *
 * The write it is reading back just applied — the relay's own receipt said
 * so — so a miss here is the read side lagging the write side, not the Task
 * being absent. `companyActionBroker.submit` already waits up to 20 * 400ms
 * for that receipt; this is a smaller, bounded wait on the read that follows
 * it, not a second copy of that budget.
 */
const DEFAULT_TASK_READBACK_ATTEMPTS = 5;
const DEFAULT_TASK_READBACK_INTERVAL_MS = 300;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  initiativeId?: string;
  status?: TaskStatus;
  teamId?: string;
  stage?: string;
  subject?: SubjectRef;
};

export type ThreadTaskQuery = {
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
      ids?: string[];
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
  function collectHeads<T>(
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
     * A community has exactly one, at a fixed coordinate. Absent simply means
     * the owner has not described the business yet; nothing else in Work
     * depends on it existing, so callers must not gate on it.
     */
    async getActiveCompany(): Promise<CompanyParseResult<CompanyProfile>> {
      return read<CompanyProfile>(
        (relaySelfPubkey) => ({
          kinds: [KIND_COMPANY_PROFILE],
          authors: [relaySelfPubkey],
          "#d": [COMMUNITY_PROFILE_ID],
          limit: 8,
        }),
        (events, relaySelfPubkey) => {
          const profile = collectHeads(
            events,
            relaySelfPubkey,
            parseCompanyHead,
          )[0];
          return profile
            ? { ok: true, value: profile }
            : companyFailure<CompanyProfile>(
                "missing-head",
                "This community has not described its business yet.",
              );
        },
      );
    },

    /**
     * The profile together with the event id of the head it came from.
     *
     * Editing is a read-modify-write against a record the onboarding
     * interview also writes, so a form has to be able to say which version it
     * was populated from. Without that the owner's Save would silently
     * discard whatever an agent wrote while the form was open.
     */
    async getActiveCompanyHead(): Promise<
      CompanyParseResult<{ profile: CompanyProfile; headEventId: string }>
    > {
      return read<{ profile: CompanyProfile; headEventId: string }>(
        (relaySelfPubkey) => ({
          kinds: [KIND_COMPANY_PROFILE],
          authors: [relaySelfPubkey],
          "#d": [COMMUNITY_PROFILE_ID],
          limit: 8,
        }),
        (events, relaySelfPubkey) => {
          const head = newestHead(
            events.filter(
              (event) =>
                normalizeHex(event.pubkey) === normalizeHex(relaySelfPubkey),
            ),
          );
          if (!head) {
            return companyFailure("missing-head", "No community profile yet.");
          }
          const parsed = parseCompanyHead(head, relaySelfPubkey);
          return parsed.ok
            ? {
                ok: true,
                value: { profile: parsed.value, headEventId: head.id },
              }
            : parsed;
        },
      );
    },

    async listInitiatives(): Promise<CompanyParseResult<Initiative[]>> {
      return read<Initiative[]>(
        (relaySelfPubkey) => ({
          kinds: [KIND_INITIATIVE],
          authors: [relaySelfPubkey],
          limit: MAX_RECORDS,
        }),
        (events, relaySelfPubkey) => ({
          ok: true,
          value: collectHeads(
            events,
            relaySelfPubkey,
            parseInitiativeHead,
          ).sort((left, right) => left.id.localeCompare(right.id)),
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

    /** Cohorts are inert data: no status narrow, sorted by id like initiatives. */
    async listCohorts(): Promise<CompanyParseResult<Cohort[]>> {
      return read<Cohort[]>(
        (relaySelfPubkey) => ({
          kinds: [KIND_COHORT],
          authors: [relaySelfPubkey],
          limit: MAX_RECORDS,
        }),
        (events, relaySelfPubkey) => ({
          ok: true,
          value: collectHeads(events, relaySelfPubkey, parseCohortHead).sort(
            (left, right) => left.id.localeCompare(right.id),
          ),
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

    /**
     * Read a Task back right after publishing it, tolerating index lag.
     *
     * Distinct from `getTask` because the two calls have different premises:
     * an ordinary lookup that finds nothing means the Task genuinely doesn't
     * exist (or was never this community's), so it should fail fast. This is
     * called only once a relay receipt has already confirmed the write
     * happened — a miss here is the read lagging the write, not the Task
     * being gone — so it is worth retrying.
     *
     * `headEventId` (the relay receipt's own event id, when the caller has
     * one) is tried first: a lookup by `ids` hits the event store directly,
     * ahead of whatever indexes the `#d` tag filter below depends on. Absent
     * that — a conflict outcome names no head — or once the id lookup itself
     * comes up empty, this falls back to the ordinary coordinate read.
     */
    async getTaskAfterAction(
      taskId: string,
      headEventId: string | null = null,
    ): Promise<CompanyParseResult<CompanyTask>> {
      const attempts =
        dependencies.taskReadBackAttempts ?? DEFAULT_TASK_READBACK_ATTEMPTS;
      const intervalMs =
        dependencies.taskReadBackIntervalMs ??
        DEFAULT_TASK_READBACK_INTERVAL_MS;
      const wait = dependencies.delay ?? defaultDelay;

      const readByCoordinate = () =>
        read<CompanyTask>(
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

      const readByHeadEventId = (eventId: string) =>
        read<CompanyTask>(
          (relaySelfPubkey) => ({
            kinds: [KIND_TASK],
            authors: [relaySelfPubkey],
            ids: [eventId],
            limit: 1,
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

      let last: CompanyParseResult<CompanyTask> = companyFailure(
        "missing-head",
        "That task does not exist on this community.",
      );
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        last = headEventId
          ? await readByHeadEventId(headEventId)
          : await readByCoordinate();
        if (last.ok) return last;
        // A cancelled read (community switch mid-flight) is not indexing lag;
        // retrying it would just deliver a stale result into the new
        // community once it eventually resolves.
        if (last.code === "cancelled") return last;
        if (attempt < attempts - 1) await wait(intervalMs);
      }
      return last;
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
