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
// 5 x 300ms gave up after 1.2s, and a send whose Task the relay had already
// recorded was refused with "the work record for this message could not be
// read back" - observed in production on 2026-09-01 at 11:57:03 and 11:57:20
// UTC, with both Task heads present in the relay and parsing cleanly against
// the shipped contract. The write landed; only the read that follows it timed
// out.
//
// Backing off rather than adding evenly spaced attempts: indexing lag is
// usually tens of milliseconds, so the first retries stay tight and the tail
// is what grows. 8 attempts reach ~6.9s in the worst case and still return
// immediately in the common one.
const DEFAULT_TASK_READBACK_ATTEMPTS = 8;
const DEFAULT_TASK_READBACK_INTERVAL_MS = 150;
const MAX_TASK_READBACK_INTERVAL_MS = 2_000;

/** Backoff for read-after-write: doubles, capped, never below the interval. */
export function taskReadBackDelay(
  attempt: number,
  intervalMs: number,
  maxMs: number = MAX_TASK_READBACK_INTERVAL_MS,
): number {
  return Math.min(intervalMs * 2 ** attempt, maxMs);
}

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

/**
 * Hidden tasks are never listed.
 *
 * A hidden task exists so a turn that was not work ("are you there?") still
 * charges somewhere. It is an accounting record, and putting it on the Tasks
 * page, in a queue, or in a thread's task history would put the greeting back
 * in front of the owner as if it were work. Filtered here rather than at each
 * surface, because every surface reads through this repository and a surface
 * that forgot would leak them.
 */
function isListableTask(task: CompanyTask): boolean {
  return !task.hidden;
}

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
            .filter(
              (task) => isListableTask(task) && taskMatchesQuery(task, query),
            )
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
                isListableTask(task) &&
                task.threadRoot !== null &&
                normalizeHex(task.threadRoot) ===
                  normalizeHex(query.threadRoot),
            )
            .sort(threadHistoryOrder),
        }),
      );
    },

    /**
     * One DM conversation's task history, same order as a thread's.
     *
     * A DM is one thread for its whole life, so its tasks name no thread root
     * at all. They are found by the channel they were opened in instead, which
     * is not an indexed mirror either, so this narrows client-side under the
     * same MAX_RECORDS ceiling `listThreadTasks` documents.
     */
    async listConversationTasks(
      channelId: string,
    ): Promise<CompanyParseResult<CompanyTask[]>> {
      if (channelId.trim() === "") {
        return companyFailure<CompanyTask[]>(
          "invalid-record",
          "Listing a conversation's tasks requires the channel it happens in.",
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
                isListableTask(task) &&
                task.threadRoot === null &&
                task.sourceChannelId === channelId,
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
     * that - a conflict or superseded outcome names no head - or once the id
     * lookup comes up empty, every attempt falls back to the ordinary
     * coordinate read. Only a cancelled read stops the fallback, because a
     * community switch mid-flight makes a second query worse, not better.
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
        if (headEventId) {
          last = await readByHeadEventId(headEventId);
          if (last.ok) return last;
          // A cancelled read (community switch mid-flight) is not indexing
          // lag; retrying it, or falling through to a second query, would
          // just deliver a stale result into the new community.
          if (last.code === "cancelled") return last;
        }
        // An id that names no task head can never match this filter, however
        // many times it is tried: a superseded claim names the company action
        // that won it, which the owner signed under a different kind. The
        // coordinate read is the one that resolves that Task.
        last = await readByCoordinate();
        if (last.ok) return last;
        if (last.code === "cancelled") return last;
        if (attempt < attempts - 1) {
          await wait(taskReadBackDelay(attempt, intervalMs));
        }
      }
      return last;
    },

    /**
     * Read the Task a relay receipt named, without knowing its id.
     *
     * A thread attach is answered with a head event id and nothing else: the
     * relay decides which Task the send belongs to, so the client has no
     * coordinate to read by. Hidden tasks come back here on purpose - the
     * message still has to carry the id of whatever it was charged to, even
     * when that is the thread's hidden chat task.
     *
     * Retried on the same backoff as `getTaskAfterAction` and for the same
     * reason: the receipt already proved the write landed, so a miss is the
     * read side lagging it.
     */
    async getTaskByHeadEvent(
      headEventId: string,
    ): Promise<CompanyParseResult<CompanyTask>> {
      const attempts =
        dependencies.taskReadBackAttempts ?? DEFAULT_TASK_READBACK_ATTEMPTS;
      const intervalMs =
        dependencies.taskReadBackIntervalMs ??
        DEFAULT_TASK_READBACK_INTERVAL_MS;
      const wait = dependencies.delay ?? defaultDelay;

      let last: CompanyParseResult<CompanyTask> = companyFailure(
        "missing-head",
        "That task does not exist on this community.",
      );
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        last = await read<CompanyTask>(
          (relaySelfPubkey) => ({
            kinds: [KIND_TASK],
            authors: [relaySelfPubkey],
            ids: [headEventId],
            limit: 1,
          }),
          (events, relaySelfPubkey) => {
            const task = collectHeads(
              events,
              relaySelfPubkey,
              parseTaskHead,
            )[0];
            return task
              ? { ok: true, value: task }
              : companyFailure<CompanyTask>(
                  "missing-head",
                  "That task does not exist on this community.",
                );
          },
        );
        if (last.ok) return last;
        if (last.code === "cancelled") return last;
        if (attempt < attempts - 1) {
          await wait(taskReadBackDelay(attempt, intervalMs));
        }
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
