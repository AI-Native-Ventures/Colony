import type { RelayEvent } from "@/shared/api/types";
import { assertFirstJobRetryCanReachReceiver } from "./firstJobDelivery";
import {
  FIRST_JOB_BRIEF_MAX_LENGTH,
  snapshotFirstJobScope,
  type FirstJobScope,
  type FirstJobTeam,
} from "./firstJobStart";

/** Immutable task receipt references read from the winning action's head. */
export type FirstJobWork = {
  actionId: string;
  taskId: string;
  tags: string[][];
  /** Timestamp of the accepted action; the instruction is signed after readiness. */
  createdAt: number;
};

/** Public signed data required to retry an uncertain send without another turn. */
export type FirstJobDispatchAttempt = {
  /** Distinguishes devices even when identical briefs are started in the same second. */
  nonce: string;
  /** Advances only after a relay-signed refusal proves no claim was applied. */
  revision?: number;
  content: string;
  team: FirstJobTeam;
  action: RelayEvent | null;
  work: FirstJobWork | null;
  message: RelayEvent | null;
  acknowledged: boolean;
};

/** Only the native adapter's verified, exact-action failure receipt creates this error. */
export class FirstJobTaskRefused extends Error {
  readonly actionId: string;
  constructor(actionId: string) {
    super(
      "The task request was refused before work started. Review your business setup, then try again.",
    );
    this.name = "FirstJobTaskRefused";
    this.actionId = actionId;
  }
}

/** Native adapters retain ownership, signing, canonical task policy and runtime isolation. */
export type FirstJobDispatchDependencies = {
  assertCurrent(scope: FirstJobScope): Promise<void>;
  withLock<T>(scope: FirstJobScope, work: () => Promise<T>): Promise<T>;
  read(scope: FirstJobScope): FirstJobDispatchAttempt | null;
  write(scope: FirstJobScope, attempt: FirstJobDispatchAttempt): void;
  now?: () => number;
  /** Commit the FULL brief and both actor identities in the native attach binding. */
  plan(input: {
    scope: FirstJobScope;
    content: string;
    team: FirstJobTeam;
    revision?: number;
    nonce: string;
  }): Promise<RelayEvent>;
  /** Submit the exact saved action; a different winning action cannot authorize dispatch. */
  resolveWork(
    scope: FirstJobScope,
    action: RelayEvent,
    team: FirstJobTeam,
  ): Promise<FirstJobWork>;
  /** Recheck the current canonical head; a creation receipt can outlive approval. */
  validateWork(
    scope: FirstJobScope,
    team: FirstJobTeam,
    work: FirstJobWork,
  ): Promise<void>;
  startTeam(scope: FirstJobScope, team: FirstJobTeam): Promise<void>;
  /** Sign fresh message bytes after runtime readiness, retaining canonical work tags. */
  prepareMessage(input: {
    scope: FirstJobScope;
    content: string;
    team: FirstJobTeam;
    work: FirstJobWork;
  }): Promise<RelayEvent>;
  publish(scope: FirstJobScope, event: RelayEvent): Promise<void>;
};

function isEvent(value: unknown): value is RelayEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<RelayEvent>;
  return (
    typeof event.id === "string" &&
    /^[a-f0-9]{64}$/.test(event.id) &&
    typeof event.pubkey === "string" &&
    /^[a-f0-9]{64}$/.test(event.pubkey) &&
    typeof event.sig === "string" &&
    /^[a-f0-9]{128}$/.test(event.sig) &&
    typeof event.content === "string" &&
    event.content.length <= 32_000 &&
    Number.isSafeInteger(event.kind) &&
    Number.isSafeInteger(event.created_at) &&
    (event.created_at ?? -1) >= 0 &&
    Array.isArray(event.tags) &&
    event.tags.length <= 64 &&
    event.tags.every(
      (tag) =>
        Array.isArray(tag) &&
        tag.length <= 8 &&
        tag.every(
          (value) => typeof value === "string" && value.length <= 16_384,
        ),
    )
  );
}

/** Verify saved instruction scope before either publication or receipt recovery. */
export function assertFirstJobMessageScope(
  message: RelayEvent,
  scope: FirstJobScope,
  team: FirstJobTeam,
  work: FirstJobWork,
) {
  const tags = (name: string) => message.tags.filter((tag) => tag[0] === name);
  if (
    message.pubkey !== scope.ownerPubkey ||
    message.kind !== 9 ||
    message.created_at < work.createdAt ||
    JSON.stringify(tags("h")) !== JSON.stringify([["h", scope.channelId]]) ||
    JSON.stringify(tags("e")) !==
      JSON.stringify([["e", scope.threadRootId, "", "reply"]]) ||
    JSON.stringify(tags("p")) !== JSON.stringify([["p", team.scoutPubkey]]) ||
    JSON.stringify(
      message.tags.filter((tag) =>
        ["task", "team", "initiative"].includes(tag[0] ?? ""),
      ),
    ) !== JSON.stringify(work.tags)
  )
    throw new Error(
      "The saved job message could not be verified for this thread.",
    );
}

/** Corrupt persisted retry data is an error, never permission to prepare a fresh send. */
export function isFirstJobDispatchAttempt(
  value: unknown,
): value is FirstJobDispatchAttempt {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<FirstJobDispatchAttempt>;
  const work = item.work;
  return (
    typeof item.nonce === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      item.nonce,
    ) &&
    typeof item.content === "string" &&
    (item.revision === undefined ||
      (Number.isSafeInteger(item.revision) &&
        item.revision >= 0 &&
        item.revision <= 100)) &&
    Boolean(item.content.trim()) &&
    item.content.length <= FIRST_JOB_BRIEF_MAX_LENGTH &&
    typeof item.team?.scoutPubkey === "string" &&
    /^[a-f0-9]{64}$/.test(item.team.scoutPubkey) &&
    typeof item.team.workerPubkey === "string" &&
    /^[a-f0-9]{64}$/.test(item.team.workerPubkey) &&
    item.team.scoutPubkey !== item.team.workerPubkey &&
    (item.action === null || isEvent(item.action)) &&
    (work === null ||
      Boolean(
        work &&
          item.action &&
          work.actionId === item.action.id &&
          typeof work.taskId === "string" &&
          work.taskId.length > 0 &&
          work.taskId.length <= 128 &&
          work.createdAt === item.action.created_at &&
          Array.isArray(work.tags) &&
          work.tags.length <= 3 &&
          work.tags.every(
            (tag) =>
              Array.isArray(tag) &&
              tag.length === 2 &&
              ["task", "team", "initiative"].includes(tag[0] ?? "") &&
              typeof tag[1] === "string" &&
              tag[1].length <= 128,
          ) &&
          work.tags.filter((tag) => tag[0] === "task" && tag[1] === work.taskId)
            .length === 1 &&
          work.tags.filter((tag) => tag[0] === "team").length === 1,
      )) &&
    (item.message === null || Boolean(work && isEvent(item.message))) &&
    typeof item.acknowledged === "boolean" &&
    (!item.acknowledged || Boolean(item.message))
  );
}

/** Prepare once, persist before effects, then retry the exact accepted instruction. */
export function createFirstJobDispatcher(deps: FirstJobDispatchDependencies) {
  return async function dispatch(input: {
    scope: FirstJobScope;
    content: string;
    team: FirstJobTeam;
  }): Promise<{ eventId: string; taskId: string }> {
    const scope = snapshotFirstJobScope(input.scope);
    const content = input.content.trim();
    const team = Object.freeze({ ...input.team });
    return deps.withLock(scope, async () => {
      await deps.assertCurrent(scope);
      let attempt = deps.read(scope);
      if (
        attempt &&
        (attempt.content !== content ||
          attempt.team.scoutPubkey !== team.scoutPubkey ||
          attempt.team.workerPubkey !== team.workerPubkey)
      ) {
        throw new Error(
          "A previous Start is saved for this thread. Resume that attempt before changing the brief or team.",
        );
      }
      if (!attempt) {
        attempt = {
          nonce: crypto.randomUUID(),
          content,
          team,
          action: null,
          work: null,
          message: null,
          acknowledged: false,
        };
        if (!isFirstJobDispatchAttempt(attempt))
          throw new Error("This first-job request is invalid.");
        deps.write(scope, attempt);
      }
      if (!isFirstJobDispatchAttempt(attempt))
        throw new Error("The saved first-job attempt could not be read.");
      const save = (next: FirstJobDispatchAttempt) => {
        if (!isFirstJobDispatchAttempt(next))
          throw new Error("The first-job receipt could not be verified.");
        deps.write(scope, next);
        attempt = next;
      };
      if (attempt.acknowledged && attempt.message && attempt.work) {
        assertFirstJobMessageScope(attempt.message, scope, team, attempt.work);
        return { eventId: attempt.message.id, taskId: attempt.work.taskId };
      }
      if (!attempt.action) {
        const action = await deps.plan({
          scope,
          content,
          team,
          revision: attempt.revision ?? 0,
          nonce: attempt.nonce,
        });
        await deps.assertCurrent(scope);
        if (action.pubkey !== scope.ownerPubkey)
          throw new Error("The account changed before this job could start.");
        save({ ...attempt, action });
      }
      const action = attempt.action;
      if (!action || action.pubkey !== scope.ownerPubkey)
        throw new Error("The saved request belongs to a different account.");
      if (!attempt.work) {
        let work: FirstJobWork;
        try {
          work = await deps.resolveWork(scope, action, team);
        } catch (error) {
          await deps.assertCurrent(scope);
          if (
            error instanceof FirstJobTaskRefused &&
            error.actionId === action.id
          ) {
            // No retry is sent in this action. Persist a new binding revision
            // for the owner's NEXT click, retaining the same shared claim key.
            save({
              ...attempt,
              action: null,
              revision: (attempt.revision ?? 0) + 1,
            });
          }
          throw error;
        }
        await deps.assertCurrent(scope);
        if (work.actionId !== action.id) {
          throw new Error(
            "This job was started from another window or device. Check this thread for its progress; another instruction has not been sent.",
          );
        }
        save({ ...attempt, work });
      }
      const work = attempt.work;
      if (!work)
        throw new Error("The task for this job could not be confirmed.");
      const nowSeconds = () => Math.floor((deps.now ?? Date.now)() / 1000);
      assertFirstJobRetryCanReachReceiver(attempt.message, nowSeconds());
      await deps.validateWork(scope, team, work);
      await deps.assertCurrent(scope);
      await deps.startTeam(scope, team);
      await deps.assertCurrent(scope);
      assertFirstJobRetryCanReachReceiver(attempt.message, nowSeconds());
      await deps.validateWork(scope, team, work);
      await deps.assertCurrent(scope);
      if (!attempt.message) {
        const message = await deps.prepareMessage({
          scope,
          content,
          team,
          work,
        });
        await deps.assertCurrent(scope);
        save({ ...attempt, message });
      }
      const message = attempt.message;
      if (!message) {
        throw new Error("The saved job message could not be verified.");
      }
      assertFirstJobMessageScope(message, scope, team, work);
      await deps.publish(scope, message);
      await deps.assertCurrent(scope);
      save({ ...attempt, acknowledged: true });
      return { eventId: message.id, taskId: work.taskId };
    });
  };
}
