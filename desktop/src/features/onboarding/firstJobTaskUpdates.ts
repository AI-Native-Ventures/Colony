import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";
import { KIND_TASK } from "@/shared/constants/kinds";
import { parseTaskHead } from "@/features/company/contracts";
import { snapshotFirstJobScope, type FirstJobScope } from "./firstJobStart";

/** A visible canonical task, bound to the owner's current business. */
export type FirstJobTaskScope = FirstJobScope & {
  communityId: string;
  taskId: string;
};

/** Existing relay transport and canonical query invalidation; no task data is stored here. */
export type FirstJobTaskUpdateDependencies = {
  assertCurrent(scope: FirstJobTaskScope): Promise<void>;
  relaySelf(): Promise<string | null>;
  subscribe(
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
    onReady: () => void,
  ): Promise<() => Promise<void>>;
  invalidate(scope: FirstJobTaskScope): Promise<void>;
  schedule?: (callback: () => void, delay: number) => () => void;
};

/** Share one relay subscription between visible copies of an onboarding task. */
export function createFirstJobTaskUpdates(
  deps: FirstJobTaskUpdateDependencies,
) {
  type Entry = {
    scope: FirstJobTaskScope;
    readers: number;
    generation: number;
    refreshing: boolean;
    dirty: boolean;
    retryDelay: number;
    cancelRetry?: () => void;
    unsubscribe?: () => Promise<void>;
  };
  const entries = new Map<string, Entry>();
  const schedule =
    deps.schedule ??
    ((callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    });
  const alive = (entry: Entry, generation: number) =>
    entry.readers > 0 && entry.generation === generation;
  const close = (unsubscribe: () => Promise<void>) => {
    void unsubscribe().catch(() => {});
  };

  async function refresh(entry: Entry) {
    if (entry.readers === 0) return;
    entry.dirty = true;
    if (entry.refreshing) return;
    entry.refreshing = true;
    try {
      while (entry.dirty && entry.readers > 0) {
        entry.dirty = false;
        await deps.assertCurrent(entry.scope);
        if (entry.readers === 0) return;
        // Read the authoritative repository again; an event is only a wakeup,
        // never a second source of task state or a chat-based completion signal.
        await deps.invalidate(entry.scope);
      }
    } catch {
      // A switched account/community must not refresh the new scope's data.
      // Query failures themselves retain React Query's existing retry policy.
    } finally {
      entry.refreshing = false;
    }
  }

  async function connect(entry: Entry) {
    const generation = ++entry.generation;
    let unsubscribe: (() => Promise<void>) | undefined;
    try {
      await deps.assertCurrent(entry.scope);
      if (!alive(entry, generation)) return;
      const relaySelf = await deps.relaySelf();
      await deps.assertCurrent(entry.scope);
      if (!alive(entry, generation)) return;
      if (!relaySelf || !/^[0-9a-f]{64}$/i.test(relaySelf))
        throw new Error("The community relay identity is unavailable.");
      unsubscribe = await deps.subscribe(
        {
          kinds: [KIND_TASK],
          authors: [relaySelf],
          "#d": [entry.scope.taskId],
          limit: 1,
        },
        (event) => {
          if (!alive(entry, generation)) return;
          const head = parseTaskHead(event, relaySelf);
          if (head.ok && head.value.id === entry.scope.taskId)
            void refresh(entry);
        },
        () => {
          // Includes the initial read/subscribe gap. subscribeLive also replays
          // canonical heads after reconnect through its existing transport.
          if (alive(entry, generation)) void refresh(entry);
        },
      );
      await deps.assertCurrent(entry.scope);
      if (!alive(entry, generation)) {
        close(unsubscribe);
        return;
      }
      entry.unsubscribe = unsubscribe;
      entry.retryDelay = 1_000;
    } catch {
      if (unsubscribe) close(unsubscribe);
      if (!alive(entry, generation)) return;
      const retryGeneration = ++entry.generation;
      // Initial connection failures must not leave a visible card permanently
      // stale. Once subscribed, reconnect/replay belongs to relayClient.
      entry.cancelRetry = schedule(() => {
        entry.cancelRetry = undefined;
        if (alive(entry, retryGeneration)) void connect(entry);
      }, entry.retryDelay);
      entry.retryDelay = Math.min(entry.retryDelay * 2, 30_000);
    }
  }

  return {
    retain(input: FirstJobTaskScope) {
      const scope = Object.freeze({
        ...snapshotFirstJobScope(input),
        communityId: input.communityId,
        taskId: input.taskId,
      });
      const key = JSON.stringify([
        scope.ownerPubkey,
        scope.relayUrl,
        scope.communityId,
        scope.taskId,
      ]);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          scope,
          readers: 0,
          generation: 0,
          refreshing: false,
          dirty: false,
          retryDelay: 1_000,
        };
        entries.set(key, entry);
      }
      entry.readers += 1;
      if (entry.readers === 1) void connect(entry);
      const retained = entry;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        retained.readers -= 1;
        if (retained.readers !== 0) return;
        retained.generation += 1;
        retained.cancelRetry?.();
        if (retained.unsubscribe) close(retained.unsubscribe);
        entries.delete(key);
      };
    },
  };
}
