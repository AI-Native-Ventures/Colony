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
} from "./contracts";
import {
  companyFailure,
  newestHead,
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

export type TaskQuery = {
  companyId?: string;
  initiativeId?: string;
};

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
          ...(query.initiativeId
            ? { "#initiative": [query.initiativeId] }
            : { "#c": [query.companyId as string] }),
          limit: MAX_RECORDS,
        }),
        (events, relaySelfPubkey) => ({
          ok: true,
          value: collectHeads(events, relaySelfPubkey, parseTaskHead)
            .filter(
              (task) =>
                (!query.companyId || task.companyId === query.companyId) &&
                (!query.initiativeId ||
                  task.initiativeId === query.initiativeId),
            )
            .sort((left, right) => left.id.localeCompare(right.id)),
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
