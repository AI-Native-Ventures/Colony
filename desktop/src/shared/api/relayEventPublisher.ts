import {
  activateRateLimit,
  parseRateLimitHint,
  rateLimitRemainingMs,
  waitForRateLimit,
} from "@/shared/api/relayRateLimitGate";
import type { PendingEvent } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";

type RelayEventPublisherDependencies = {
  currentCommunityGeneration: () => number;
  ensureConnected: () => Promise<void>;
  pendingEvents: Map<string, PendingEvent>;
  recoverFromSocketFailure: (error: unknown, fallbackMessage: string) => Error;
  sendRaw: (payload: unknown[]) => Promise<void>;
};

const MAX_RATE_LIMIT_RETRIES = 3;

// Only the exact-ID OK dispatcher creates this marker. A socket error or a
// generic NOTICE with identical text does not authorize a rejected-event retry.
class RelayEventRejection extends Error {
  readonly eventId: string;

  constructor(eventId: string, message: string) {
    super(message || "Relay rejected the event.");
    this.eventId = eventId;
  }
}

/** Deliver an explicit relay OK to its matching publish operation. */
export function handleRelayEventOk(
  pendingEvents: Map<string, PendingEvent>,
  eventId: string,
  accepted: boolean,
  message: string,
) {
  const pending = pendingEvents.get(eventId);
  if (!pending) return;
  if (accepted) pending.resolve(pending.event);
  else pending.reject(new RelayEventRejection(eventId, message));
}

function communityChangedError() {
  return new Error("Relay publish cancelled because the community changed.");
}

function removePendingEvent(
  pendingEvents: Map<string, PendingEvent>,
  eventId: string,
  pendingEvent: PendingEvent,
) {
  if (pendingEvents.get(eventId) !== pendingEvent) return false;
  pendingEvents.delete(eventId);
  return true;
}

/** Publish one signed event within one deadline, including gates and retries. */
export function publishRelayEvent(
  dependencies: RelayEventPublisherDependencies,
  event: RelayEvent,
  timeoutMessage: string,
  sendErrorMessage: string,
  timeoutMs: number,
) {
  const communityGeneration = dependencies.currentCommunityGeneration();
  const deadline = Date.now() + timeoutMs;

  return new Promise<RelayEvent>((resolve, reject) => {
    let settled = false;
    let hasSent = false;
    let rateLimitRetries = 0;
    let rateRetryScheduled = false;
    let transportRetryUsed = false;
    let sendAttemptNumber = 0;
    let lastRejection: RelayEventRejection | null = null;

    function cleanup() {
      settled = true;
      window.clearTimeout(pendingEvent.timeout);
      removePendingEvent(dependencies.pendingEvents, event.id, pendingEvent);
    }

    function fail(error: Error) {
      if (settled) return;
      cleanup();
      reject(error);
    }

    function isCurrent(detachedForReconnect = false) {
      if (settled) return false;
      if (communityGeneration !== dependencies.currentCommunityGeneration()) {
        fail(communityChangedError());
        return false;
      }
      if (Date.now() >= deadline) {
        fail(lastRejection ?? new Error(timeoutMessage));
        return false;
      }
      const current = dependencies.pendingEvents.get(event.id);
      if (current !== pendingEvent && !(detachedForReconnect && !current)) {
        fail(
          new Error("Relay publish was superseded by another pending event."),
        );
        return false;
      }
      return true;
    }

    function rejectSocket(error: unknown, fallbackMessage: string) {
      if (!isCurrent(true)) return;
      removePendingEvent(dependencies.pendingEvents, event.id, pendingEvent);
      fail(dependencies.recoverFromSocketFailure(error, fallbackMessage));
    }

    async function sendAfterGate(detachedForReconnect = false) {
      do {
        await waitForRateLimit();
        if (!isCurrent(detachedForReconnect)) return;
        // Another NOTICE may extend or reopen the shared gate while we resume.
      } while (rateLimitRemainingMs() > 0);
      if (detachedForReconnect) {
        dependencies.pendingEvents.set(event.id, pendingEvent);
      }
      rateRetryScheduled = false;
      await sendAttempt();
    }

    async function sendAttempt() {
      if (!isCurrent()) return;
      const attemptNumber = ++sendAttemptNumber;
      hasSent = true;
      // Once transmitted again, a missing ACK is ambiguous rather than the
      // previous known rejection (callers distinguish this from offline work).
      lastRejection = null;
      try {
        await dependencies.sendRaw(["EVENT", event]);
      } catch (error) {
        // An ACK can precede completion of the native send call. Its explicit
        // rejection, or a newer attempt, already owns recovery in that case.
        if (
          settled ||
          attemptNumber !== sendAttemptNumber ||
          rateRetryScheduled
        )
          return;
        if (!isCurrent()) return;
        if (transportRetryUsed) {
          rejectSocket(error, sendErrorMessage);
          return;
        }
        transportRetryUsed = true;
        // Preserve the existing one reconnect retry without resetConnection
        // rejecting this operation along with the other socket waiters.
        removePendingEvent(dependencies.pendingEvents, event.id, pendingEvent);
        let fallbackMessage = sendErrorMessage;
        try {
          fallbackMessage = dependencies.recoverFromSocketFailure(
            error,
            sendErrorMessage,
          ).message;
          await dependencies.ensureConnected();
          if (!isCurrent(true)) return;
          await sendAfterGate(true);
        } catch (retryError) {
          rejectSocket(retryError, fallbackMessage);
        }
      }
    }

    const pendingEvent: PendingEvent = {
      event,
      timeout: 0,
      resolve(value) {
        if (!hasSent || !isCurrent()) return;
        cleanup();
        resolve(value);
      },
      reject(error) {
        if (!(error instanceof RelayEventRejection)) {
          fail(error);
          return;
        }
        if (!hasSent || !isCurrent()) return;
        if (
          error.eventId !== event.id ||
          !error.message.startsWith("rate-limited:")
        ) {
          fail(error);
          return;
        }
        // Keep the entry while waiting so a success ACK or disconnect can
        // settle it, and duplicate rejections cannot queue multiple retries.
        if (rateRetryScheduled) return;
        if (rateLimitRetries >= MAX_RATE_LIMIT_RETRIES) {
          fail(error);
          return;
        }
        lastRejection = error;
        rateLimitRetries++;
        rateRetryScheduled = true;
        activateRateLimit(parseRateLimitHint(error.message));
        void sendAfterGate();
      },
    };
    pendingEvent.timeout = window.setTimeout(() => {
      fail(lastRejection ?? new Error(timeoutMessage));
    }, timeoutMs);
    dependencies.pendingEvents.set(event.id, pendingEvent);
    void sendAfterGate();
  });
}
