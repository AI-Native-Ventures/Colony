import { isRetryableBlockActionTransportError } from "./blockActions";

const STORAGE_KEY = "ai-native-office:block-question-queue:v1";
const MAX_QUEUED_ACTIONS = 100;
const replayByScope = new Map<string, Promise<number>>();

export type QueuedQuestionAction = {
  relayUrl: string;
  identityPubkey: string;
  channelId: string;
  instanceEventId: string;
  manifestId: string;
  instanceId: string;
  actionId: string;
  processorPubkey: string;
  data: unknown;
  idempotencyKey: string;
  queuedAt: number;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function read(storage: StorageLike): QueuedQuestionAction[] {
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? (value as QueuedQuestionAction[]) : [];
  } catch {
    return [];
  }
}

function write(storage: StorageLike, actions: QueuedQuestionAction[]) {
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify(actions.slice(-MAX_QUEUED_ACTIONS)),
  );
}

export function createBlockActionQueue(storage: StorageLike) {
  return {
    enqueue(action: QueuedQuestionAction) {
      const queued = read(storage).filter(
        (candidate) =>
          candidate.idempotencyKey !== action.idempotencyKey ||
          candidate.relayUrl !== action.relayUrl ||
          candidate.identityPubkey !== action.identityPubkey,
      );
      queued.push(action);
      write(storage, queued);
    },
    list(scope: { relayUrl: string; identityPubkey: string }) {
      return read(storage).filter(
        (action) =>
          action.relayUrl === scope.relayUrl &&
          action.identityPubkey === scope.identityPubkey,
      );
    },
    acknowledge(scope: {
      relayUrl: string;
      identityPubkey: string;
      idempotencyKey: string;
    }) {
      write(
        storage,
        read(storage).filter(
          (action) =>
            action.relayUrl !== scope.relayUrl ||
            action.identityPubkey !== scope.identityPubkey ||
            action.idempotencyKey !== scope.idempotencyKey,
        ),
      );
    },
    reset() {
      storage.removeItem(STORAGE_KEY);
    },
  };
}

function browserStorage(): StorageLike | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

export function queueQuestionAction(action: QueuedQuestionAction) {
  const storage = browserStorage();
  if (!storage) {
    throw new Error("Question actions can only be queued in the desktop app.");
  }
  createBlockActionQueue(storage).enqueue(action);
}

export function queueRetryableQuestionAction(
  error: unknown,
  action: QueuedQuestionAction,
): boolean {
  if (!isRetryableBlockActionTransportError(error)) return false;
  queueQuestionAction(action);
  return true;
}

export function resetBlockActionQueue() {
  // Community transitions must not discard durable offline answers. Entries
  // are already isolated by relay URL and signer, so only the process-local
  // replay lock needs resetting when the active community changes.
  replayByScope.clear();
}

export async function replayQueuedQuestionActions(
  scope: { relayUrl: string; identityPubkey: string },
  submit: (action: QueuedQuestionAction) => Promise<unknown>,
  storage: StorageLike | null = browserStorage(),
): Promise<number> {
  if (!storage) return 0;
  const scopeKey = `${scope.relayUrl}:${scope.identityPubkey}`;
  const existing = replayByScope.get(scopeKey);
  if (existing) return existing;

  const queue = createBlockActionQueue(storage);
  const replay = (async () => {
    let acknowledged = 0;
    for (const action of queue.list(scope)) {
      try {
        await submit(action);
        queue.acknowledge({ ...scope, idempotencyKey: action.idempotencyKey });
        acknowledged += 1;
      } catch (error) {
        if (isRetryableBlockActionTransportError(error)) {
          // Preserve this and later actions in original order for the next
          // connected transition.
          break;
        }
        // A terminal rejection cannot become sendable on reconnect. Remove it
        // so it cannot permanently block later valid answers in this scope.
        queue.acknowledge({ ...scope, idempotencyKey: action.idempotencyKey });
      }
    }
    return acknowledged;
  })();
  replayByScope.set(scopeKey, replay);
  try {
    return await replay;
  } finally {
    if (replayByScope.get(scopeKey) === replay) {
      replayByScope.delete(scopeKey);
    }
  }
}
