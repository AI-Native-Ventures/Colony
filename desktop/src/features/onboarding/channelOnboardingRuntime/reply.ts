import type { RelayEvent } from "@/shared/api/types";
import { relayClient } from "@/shared/api/relayClient";
import { subscribeToAgentObserverFrames } from "@/shared/api/observerRelay";
import { decryptObserverEvent } from "@/shared/api/tauriObserver";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { readArchivedEvents } from "@/shared/api/tauriArchive";
import { KIND_AGENT_OBSERVER_FRAME } from "@/shared/constants/kinds";

import { responseProof, type ProofFrame } from "../responseProof";
import { assertScoutReplyEvent } from "../channelOnboardingSetup";
import type {
  ScoutSetupInput,
  ScoutSetupProof,
} from "../channelOnboarding/types";
import type { ChannelOnboardingScope } from "../channelOnboardingStorage";

export type ScoutReplyVerificationInput = {
  scope: ChannelOnboardingScope;
  input: ScoutSetupInput;
  requestId: string;
  scoutPubkey: string;
  acknowledgement: {
    eventId: string;
    signedEvent?: string;
    published?: boolean;
  };
  acknowledgementEvent?: RelayEvent;
  /** Runtime context retained for one verifier invocation; not used as proof. */
  attempt?: unknown;
};

type Unsubscribe = () => void | Promise<void>;

export type ScoutReplyVerifierDependencies = {
  subscribeObserver?: (
    ownerPubkey: string,
    onEvent: (event: RelayEvent) => void,
  ) => Promise<Unsubscribe>;
  decryptObserver?: (event: RelayEvent) => Promise<unknown>;
  subscribeMessages?: (
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
  ) => Promise<Unsubscribe>;
  fetchReply?: (
    scope: ChannelOnboardingScope,
    scoutPubkey: string,
    acknowledgementEventId: string,
  ) => Promise<RelayEvent | null>;
  readObserverHistory?: (
    ownerPubkey: string,
    scoutPubkey: string,
    afterCreatedAt: number,
  ) => Promise<RelayEvent[]>;
  assertCurrent?: (scope: ChannelOnboardingScope) => Promise<void> | void;
  timeoutMs?: number;
  now?: () => number;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type OrderedProofFrame = ProofFrame & {
  seq?: number;
  timestamp?: string;
};

function frame(value: unknown): OrderedProofFrame | null {
  if (!record(value) || typeof value.kind !== "string") return null;
  if (value.turnId !== null && typeof value.turnId !== "string") return null;
  if (value.channelId !== null && typeof value.channelId !== "string")
    return null;
  return {
    kind: value.kind,
    turnId: value.turnId as string | null,
    channelId: value.channelId as string | null,
    payload: value.payload,
    ...(Number.isSafeInteger(value.seq) ? { seq: value.seq as number } : {}),
    ...(typeof value.timestamp === "string"
      ? { timestamp: value.timestamp }
      : {}),
  };
}

function frameBatch(value: unknown): OrderedProofFrame[] {
  const batchEvents =
    record(value) && value.kind === "batch"
      ? Array.isArray(value.events)
        ? value.events
        : record(value.payload) && Array.isArray(value.payload.events)
          ? value.payload.events
          : null
      : null;
  if (batchEvents) {
    return batchEvents
      .map(frame)
      .filter((item): item is OrderedProofFrame => item !== null);
  }
  const one = frame(value);
  if (one) return [one];
  if (!record(value) || !Array.isArray(value.events)) return [];
  return value.events
    .map(frame)
    .filter((item): item is OrderedProofFrame => item !== null);
}

function frameSort(left: OrderedProofFrame, right: OrderedProofFrame) {
  const leftTime = left.timestamp ?? "";
  const rightTime = right.timestamp ?? "";
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  return (left.seq ?? 0) - (right.seq ?? 0);
}

function defaultFetchReply(
  scope: ChannelOnboardingScope,
  scoutPubkey: string,
  acknowledgementEventId: string,
) {
  return relayClient.fetchFirstEvent({
    kinds: [9, 40002],
    authors: [scoutPubkey],
    "#h": [scope.channelId],
    "#e": [acknowledgementEventId],
    limit: 1,
  });
}

function defaultSubscribeMessages(
  filter: RelaySubscriptionFilter,
  onEvent: (event: RelayEvent) => void,
) {
  return relayClient.subscribeLive(filter, onEvent);
}

async function defaultReadObserverHistory(
  ownerPubkey: string,
  scoutPubkey: string,
  afterCreatedAt: number,
) {
  const events: RelayEvent[] = [];
  let before: { createdAt: number; id: string } | null = null;
  const pageSize = 200;
  for (let page = 0; page < 20; page += 1) {
    const rows = await readArchivedEvents("owner_p", ownerPubkey, {
      kinds: [KIND_AGENT_OBSERVER_FRAME],
      before,
      limit: pageSize,
    });
    if (rows.length === 0) break;
    for (const event of rows) {
      if (
        event.created_at >= afterCreatedAt &&
        event.pubkey.toLowerCase() === scoutPubkey.toLowerCase() &&
        event.tags.some(
          (tag) =>
            tag[0] === "agent" &&
            tag[1]?.toLowerCase() === scoutPubkey.toLowerCase(),
        )
      ) {
        events.push(event);
      }
    }
    const oldest = rows[rows.length - 1];
    if (
      !oldest ||
      oldest.created_at < afterCreatedAt ||
      rows.length < pageSize
    ) {
      break;
    }
    before = { createdAt: oldest.created_at, id: oldest.id };
  }
  return events;
}

function boundedError(timeoutMs: number) {
  return new Error(
    `Scout did not return a verifiable Welcome reply within ${Math.ceil(timeoutMs / 1_000)} seconds. Retry this setup to check the same request.`,
  );
}

/**
 * Wait for the exact signed Scout reply and the observer trace for its turn.
 *
 * Presence, a listening process, a runtime status, or any arbitrary message is
 * insufficient. `responseProof` requires a turn started by the acknowledgement,
 * a completed turn, and an ACP `end_turn`; the message path additionally checks
 * the Scout signature, channel, thread reference, and non-empty content.
 */
export function createScoutReplyVerifier(
  dependencies: ScoutReplyVerifierDependencies = {},
) {
  const subscribeObserver =
    dependencies.subscribeObserver ?? subscribeToAgentObserverFrames;
  const decrypt = dependencies.decryptObserver ?? decryptObserverEvent;
  const subscribeMessages =
    dependencies.subscribeMessages ?? defaultSubscribeMessages;
  const fetchReply = dependencies.fetchReply ?? defaultFetchReply;
  const readObserverHistory =
    dependencies.readObserverHistory ?? defaultReadObserverHistory;
  const timeoutMs = dependencies.timeoutMs ?? 120_000;
  const now = dependencies.now ?? Date.now;

  return async function verify(
    input: ScoutReplyVerificationInput,
  ): Promise<ScoutSetupProof> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error("Scout response verification has no valid deadline.");
    }
    const acknowledgementEventId = input.acknowledgement.eventId;
    if (
      acknowledgementEventId.trim() === "" ||
      input.acknowledgement.published !== true
    ) {
      throw new Error(
        "Scout response verification requires a published acknowledgment.",
      );
    }
    await dependencies.assertCurrent?.(input.scope);

    const proofState = responseProof(
      acknowledgementEventId,
      input.scope.channelId,
    );
    const subscriptions: Unsubscribe[] = [];
    const replyEvents: RelayEvent[] = [];
    let matchingReply: RelayEvent | null = null;
    let turnId: string | null = null;
    let successfulTurn = false;
    let settled = false;
    let resolveResult: (proof: ScoutSetupProof) => void = () => {};
    let rejectResult: (error: Error) => void = () => {};
    const result = new Promise<ScoutSetupProof>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    // Avoid an unhandled rejection while subscriptions are still being wired.
    void result.catch(() => {});
    const timer = globalThis.setTimeout(() => {
      if (!settled) rejectResult(boundedError(timeoutMs));
    }, timeoutMs);

    const startedAt = Date.now();
    const bounded = async <T>(operation: Promise<T>): Promise<T> => {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) throw boundedError(timeoutMs);
      let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(boundedError(timeoutMs)),
          remaining,
        );
      });
      try {
        return await Promise.race([operation, timeoutPromise]);
      } finally {
        if (timeout !== undefined) globalThis.clearTimeout(timeout);
      }
    };

    const finishIfReady = () => {
      if (settled || !matchingReply || !successfulTurn || !turnId) return;
      settled = true;
      const proof: ScoutSetupProof = {
        proofId: `scout-setup:${acknowledgementEventId}:${matchingReply.id}`,
        agentPubkey: input.scoutPubkey,
        channelId: input.scope.channelId,
        acknowledgementEventId,
        requestId: input.requestId,
        replyEventId: matchingReply.id,
        signedReplyEvent: JSON.stringify(matchingReply),
        turnId,
        savedAt: new Date(now()).toISOString(),
      };
      resolveResult(proof);
    };

    const acceptFrame = (candidate: ProofFrame) => {
      if (settled || candidate.channelId !== input.scope.channelId) return;
      if (
        candidate.kind === "turn_started" &&
        record(candidate.payload) &&
        Array.isArray(candidate.payload.triggeringEventIds) &&
        candidate.payload.triggeringEventIds.includes(acknowledgementEventId)
      ) {
        turnId = candidate.turnId;
      }
      if (
        turnId &&
        candidate.turnId === turnId &&
        ["turn_error", "agent_panic"].includes(candidate.kind)
      ) {
        rejectResult(
          new Error(
            "Scout could not complete the Welcome reply. Retry this setup.",
          ),
        );
        return;
      }
      const state = proofState.accept(candidate);
      if (state === "failed") {
        rejectResult(
          new Error(
            "Scout could not complete the Welcome reply. Retry this setup.",
          ),
        );
        return;
      }
      successfulTurn ||= state === "success";
      finishIfReady();
    };

    const acceptObserverEvent = (event: RelayEvent) => {
      if (
        settled ||
        event.pubkey.toLowerCase() !== input.scoutPubkey.toLowerCase() ||
        !event.tags.some(
          (tag) =>
            tag[0] === "agent" &&
            tag[1]?.toLowerCase() === input.scoutPubkey.toLowerCase(),
        )
      ) {
        return;
      }
      void decrypt(event)
        .then((value) => {
          for (const candidate of frameBatch(value).sort(frameSort)) {
            acceptFrame(candidate);
          }
        })
        .catch(() => {
          if (!settled) {
            rejectResult(
              new Error(
                "Scout's response trace could not be verified. Retry this setup.",
              ),
            );
          }
        });
    };

    const acceptMessage = (event: RelayEvent) => {
      if (
        settled ||
        event.pubkey.toLowerCase() !== input.scoutPubkey.toLowerCase()
      ) {
        return;
      }
      try {
        const reply = assertScoutReplyEvent(
          event,
          input.scope,
          input.scoutPubkey,
          acknowledgementEventId,
        );
        if (!replyEvents.some((item) => item.id === reply.id)) {
          replyEvents.push(reply);
        }
        matchingReply = reply;
        finishIfReady();
      } catch {
        // A Scout message in this channel that is unrelated or unsigned is not
        // evidence for this request and must not fail the active verification.
      }
    };

    try {
      subscriptions.push(
        await bounded(
          subscribeObserver(input.scope.ownerPubkey, acceptObserverEvent),
        ),
      );
      subscriptions.push(
        await bounded(
          subscribeMessages(
            {
              kinds: [9, 40002],
              authors: [input.scoutPubkey],
              "#h": [input.scope.channelId],
              "#e": [acknowledgementEventId],
              limit: 100,
            },
            acceptMessage,
          ),
        ),
      );
      await dependencies.assertCurrent?.(input.scope);
      const existing = await bounded(
        fetchReply(input.scope, input.scoutPubkey, acknowledgementEventId),
      );
      if (existing) acceptMessage(existing);
      const acknowledgementCreatedAt =
        input.acknowledgementEvent?.created_at ?? 0;
      const history = await bounded(
        readObserverHistory(
          input.scope.ownerPubkey,
          input.scoutPubkey,
          acknowledgementCreatedAt,
        ),
      );
      const decodedHistory: OrderedProofFrame[] = [];
      for (const event of history) {
        if (settled) break;
        const decoded = await bounded(decrypt(event));
        decodedHistory.push(...frameBatch(decoded));
      }
      decodedHistory.sort(frameSort);
      for (const candidate of decodedHistory) acceptFrame(candidate);
      await dependencies.assertCurrent?.(input.scope);
      const proof = await result;
      await dependencies.assertCurrent?.(input.scope);
      return proof;
    } finally {
      globalThis.clearTimeout(timer);
      settled = true;
      await Promise.allSettled(
        subscriptions.map(async (unsubscribe) => {
          await unsubscribe();
        }),
      );
    }
  };
}
