// desktop/src/features/onboarding/ui/OnboardingRelayConnectionErrorCard.tsx
import * as React from "react";
import { toast } from "sonner";

import { SidebarRelayConnectionCompactCard } from "@/features/sidebar/ui/SidebarRelayConnectionCard";
import { useRelayConnection } from "@/shared/api/useRelayConnection";
import { useReconnectRelay } from "@/shared/api/useReconnectRelay";

/**
 * "Can't reach the relay", with a reconnect that actually reconnects.
 *
 * A profile save that fails because the relay is unreachable is not a message
 * to read, it is a connection to fix, and this is the control that fixes it.
 * It was written for the previous flow's profile step; the screen changed,
 * the failure did not, so it moved here rather than being deleted with it.
 */

const ONBOARDING_CONNECTIVITY_SUCCESS_AUTO_DISMISS_MS = 2_500;

export function OnboardingRelayConnectionErrorCard({
  isSaving,
  message,
}: {
  isSaving: boolean;
  message: string;
}) {
  const {
    isPending: isReconnectPending,
    isWaitingOnReconnectHook,
    reconnect,
  } = useReconnectRelay();
  // Track whether a reconnect attempt was ever initiated from this card so we
  // don't call markSuccess() on a "connected" state that pre-dates any click.
  const hadActiveReconnectRef = React.useRef(false);
  const relayConnectionState = useRelayConnection();
  const [dismissedErrorMessage, setDismissedErrorMessage] = React.useState<
    string | null
  >(null);
  const [isReconnectActionPending, setIsReconnectActionPending] =
    React.useState(false);
  const [hasSuccess, setHasSuccess] = React.useState(false);
  const reconnectActionPendingRef = React.useRef(false);
  const successTimeoutRef = React.useRef<number | null>(null);
  const wasSavingRef = React.useRef(isSaving);
  const isActionPending = isReconnectActionPending || isReconnectPending;

  React.useEffect(() => {
    return () => {
      if (successTimeoutRef.current !== null) {
        window.clearTimeout(successTimeoutRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    if (isSaving && !wasSavingRef.current) {
      if (successTimeoutRef.current !== null) {
        window.clearTimeout(successTimeoutRef.current);
        successTimeoutRef.current = null;
      }
      setDismissedErrorMessage(null);
      setHasSuccess(false);
    }
    wasSavingRef.current = isSaving;
  }, [isSaving]);

  const markSuccess = React.useCallback(() => {
    setHasSuccess(true);
    if (successTimeoutRef.current !== null) {
      window.clearTimeout(successTimeoutRef.current);
    }
    successTimeoutRef.current = window.setTimeout(() => {
      successTimeoutRef.current = null;
      setDismissedErrorMessage(message);
    }, ONBOARDING_CONNECTIVITY_SUCCESS_AUTO_DISMISS_MS);
  }, [message]);

  // Observe real relay connection state. When this card initiated a reconnect
  // attempt (phase-3 path: reconnect() returns false) and the relay later
  // becomes connected, mark success. Guard: only fire when we actually
  // started a reconnect so a pre-existing connected state doesn't trigger it.
  React.useEffect(() => {
    if (relayConnectionState === "connected" && hadActiveReconnectRef.current) {
      hadActiveReconnectRef.current = false;
      markSuccess();
    }
  }, [relayConnectionState, markSuccess]);

  const runConnectivityAction = React.useCallback(
    (runAction: () => Promise<boolean | undefined>) => {
      if (reconnectActionPendingRef.current) {
        return;
      }

      hadActiveReconnectRef.current = true;
      reconnectActionPendingRef.current = true;
      setIsReconnectActionPending(true);
      setHasSuccess(false);
      void Promise.resolve()
        .then(runAction)
        .then((didReconnect) => {
          if (didReconnect !== false) {
            // Synchronous success (phase 1) — clear the ref and mark success
            // immediately. The connection-state effect won't fire because the
            // ref was just cleared.
            hadActiveReconnectRef.current = false;
            markSuccess();
          }
          // didReconnect === false means phase 3 is active; the
          // connection-state effect will call markSuccess() when the relay
          // becomes connected.
        })
        .catch((error) => {
          hadActiveReconnectRef.current = false;
          const detail = error instanceof Error ? error.message : String(error);
          toast.error(`Could not reconnect to the relay. ${detail}`);
        })
        .finally(() => {
          reconnectActionPendingRef.current = false;
          setIsReconnectActionPending(false);
        });
    },
    [markSuccess],
  );

  const handleReconnectRelay = React.useCallback(() => {
    runConnectivityAction(reconnect);
  }, [reconnect, runConnectivityAction]);

  if (dismissedErrorMessage === message) {
    return null;
  }

  return (
    <div className="fixed bottom-4 left-4 z-50 w-[calc(100vw-2rem)] text-left sm:bottom-6 sm:left-6 sm:w-[22rem]">
      <SidebarRelayConnectionCompactCard
        actionTestId="onboarding-reconnect-relay"
        isActionDisabled={isActionPending}
        isConnected={hasSuccess}
        isReconnectPending={isActionPending}
        isWaitingOnReconnectHook={isWaitingOnReconnectHook}
        onDismiss={() => setDismissedErrorMessage(message)}
        onReconnect={handleReconnectRelay}
        surface="secondary"
        testId="onboarding-relay-reconnect-card"
      />
    </div>
  );
}
