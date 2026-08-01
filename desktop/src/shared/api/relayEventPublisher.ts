import { waitForRateLimit } from "@/shared/api/relayRateLimitGate";
import type { PendingEvent } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";

type RelayEventPublisherDependencies = {
  currentCommunityGeneration: () => number;
  ensureConnected: () => Promise<void>;
  normalizeError: (error: unknown, fallbackMessage: string) => Error;
  pendingEvents: Map<string, PendingEvent>;
  recoverFromSocketFailure: (error: unknown, fallbackMessage: string) => Error;
  sendRaw: (payload: unknown[]) => Promise<void>;
};

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

export async function publishRelayEvent(
  dependencies: RelayEventPublisherDependencies,
  event: RelayEvent,
  timeoutMessage: string,
  sendErrorMessage: string,
  timeoutMs: number,
) {
  const communityGeneration = dependencies.currentCommunityGeneration();
  await waitForRateLimit();
  if (communityGeneration !== dependencies.currentCommunityGeneration()) {
    throw communityChangedError();
  }

  return new Promise<RelayEvent>((resolve, reject) => {
    const pendingEvent: PendingEvent = {
      event,
      resolve,
      reject,
      timeout: 0,
    };
    pendingEvent.timeout = window.setTimeout(() => {
      removePendingEvent(dependencies.pendingEvents, event.id, pendingEvent);
      pendingEvent.reject(new Error(timeoutMessage));
    }, timeoutMs);
    dependencies.pendingEvents.set(event.id, pendingEvent);

    void dependencies.sendRaw(["EVENT", event]).catch(async (error) => {
      if (communityGeneration !== dependencies.currentCommunityGeneration()) {
        window.clearTimeout(pendingEvent.timeout);
        removePendingEvent(dependencies.pendingEvents, event.id, pendingEvent);
        pendingEvent.reject(communityChangedError());
        return;
      }
      if (dependencies.pendingEvents.get(event.id) !== pendingEvent) {
        window.clearTimeout(pendingEvent.timeout);
        pendingEvent.reject(
          dependencies.normalizeError(error, sendErrorMessage),
        );
        return;
      }
      dependencies.pendingEvents.delete(event.id);
      const normalizedError = dependencies.recoverFromSocketFailure(
        error,
        sendErrorMessage,
      );

      try {
        await dependencies.ensureConnected();
        if (communityGeneration !== dependencies.currentCommunityGeneration()) {
          throw communityChangedError();
        }
        if (dependencies.pendingEvents.has(event.id)) {
          throw new Error(
            "Relay publish was superseded by another pending event.",
          );
        }

        dependencies.pendingEvents.set(event.id, pendingEvent);
        await dependencies.sendRaw(["EVENT", event]);
      } catch (retryError) {
        window.clearTimeout(pendingEvent.timeout);
        removePendingEvent(dependencies.pendingEvents, event.id, pendingEvent);
        if (communityGeneration !== dependencies.currentCommunityGeneration()) {
          pendingEvent.reject(communityChangedError());
          return;
        }
        const currentPendingEvent = dependencies.pendingEvents.get(event.id);
        pendingEvent.reject(
          currentPendingEvent
            ? dependencies.normalizeError(retryError, normalizedError.message)
            : dependencies.recoverFromSocketFailure(
                retryError,
                normalizedError.message,
              ),
        );
      }
    });
  });
}
