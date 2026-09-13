import * as React from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useCommunities } from "@/features/communities/useCommunities";
import type { TimelineMessage } from "@/features/messages/types";
import { useIdentityQuery } from "@/shared/api/hooks";
import type { Identity } from "@/shared/api/identityTypes";
import { getEventById } from "@/shared/api/tauri";
import type { RelayEvent } from "@/shared/api/types";

import {
  assertScoutSignedRootEnvelope,
  type ChannelOnboardingScope,
} from "../channelOnboardingSetup";
import {
  SCOUT_ONBOARDING_ROOT_KIND,
  parseScoutOnboardingRoot,
  type ScoutOnboardingRootPayload,
} from "../channelOnboardingRuntime/protocol";
import {
  ScoutOnboardingHost,
  type ScoutOnboardingHostProps,
} from "../channelOnboardingHost";

export type VerifiedScoutOnboardingMount = {
  payload: ScoutOnboardingRootPayload;
  rootEvent: RelayEvent;
  scope: ChannelOnboardingScope;
};

export type ScoutOnboardingMountInput = {
  message: Pick<
    TimelineMessage,
    | "id"
    | "kind"
    | "pending"
    | "pubkey"
    | "signerPubkey"
    | "parentId"
    | "rootId"
  >;
  rootEvent: RelayEvent | null | undefined;
  channelId: string | null | undefined;
  activeRelayUrl: string | null | undefined;
  currentPubkey: string | null | undefined;
  identityPubkey: string | null | undefined;
};

function lower(value: string | null | undefined) {
  return value?.toLowerCase() ?? "";
}

/**
 * Verify the exact owner, relay, channel, and thread tuple before rendering
 * an interactive onboarding surface. This is a pure gate so it can be tested
 * without mounting a React tree.
 */
export function getVerifiedScoutOnboardingMount(
  input: ScoutOnboardingMountInput,
): VerifiedScoutOnboardingMount | null {
  const { message, rootEvent } = input;
  if (
    !rootEvent ||
    message.pending ||
    message.id !== rootEvent.id ||
    message.kind !== SCOUT_ONBOARDING_ROOT_KIND ||
    rootEvent.kind !== SCOUT_ONBOARDING_ROOT_KIND ||
    message.parentId != null ||
    message.rootId != null ||
    !input.channelId ||
    !input.activeRelayUrl ||
    !input.currentPubkey ||
    !input.identityPubkey ||
    lower(input.currentPubkey) !== lower(input.identityPubkey)
  ) {
    return null;
  }

  const payload = parseScoutOnboardingRoot(rootEvent.tags);
  if (
    !payload ||
    payload.channelId !== input.channelId ||
    payload.relayUrl !== input.activeRelayUrl ||
    lower(payload.ownerPubkey) !== lower(input.currentPubkey) ||
    (message.pubkey && lower(message.pubkey) !== lower(payload.ownerPubkey)) ||
    (message.signerPubkey &&
      lower(message.signerPubkey) !== lower(payload.ownerPubkey))
  ) {
    return null;
  }

  const scope: ChannelOnboardingScope = {
    ownerPubkey: payload.ownerPubkey,
    relayUrl: payload.relayUrl,
    channelId: payload.channelId,
    threadRootId: rootEvent.id,
    requestId: payload.requestId,
  };
  try {
    assertScoutSignedRootEnvelope(scope, rootEvent);
  } catch {
    return null;
  }
  return { payload, rootEvent, scope };
}

/**
 * The source lookup is scoped by relay and event id so a Welcome root from a
 * different community can never satisfy a cached query. Keeping this key
 * public makes the account/relay isolation explicit and testable.
 */
export function scoutOnboardingRootQueryKey(
  relayUrl: string | null | undefined,
  eventId: string,
) {
  return ["scout-onboarding-root", relayUrl ?? "", eventId] as const;
}

type ForwardedHostProps = Pick<
  ScoutOnboardingHostProps,
  | "initialState"
  | "runtime"
  | "runtimeDependencies"
  | "onContinueInWelcome"
  | "onConfirm"
  | "className"
>;

export type ScoutOnboardingMessageProps = ForwardedHostProps & {
  message: TimelineMessage;
  /** Optional adapter fast path; the default fetches the exact signed event. */
  rootEvent?: RelayEvent;
  channelId: string | null | undefined;
  currentPubkey?: string;
  children: ReactNode;
};

function isUsableIdentity(
  identity: Identity | undefined,
): identity is Identity {
  return Boolean(
    identity &&
      !identity.locked &&
      !identity.lost &&
      !identity.resetFailed &&
      identity.pubkey.trim(),
  );
}

/**
 * Inline owner-facing onboarding for the verified Welcome root. The parent
 * message row still owns the signed root's ordinary Markdown; this component
 * appends the controlled conversation fragment below it.
 */
export function ScoutOnboardingMessage({
  children,
  message,
  rootEvent,
  channelId,
  currentPubkey,
  initialState,
  runtime,
  runtimeDependencies,
  onContinueInWelcome,
  onConfirm,
  className,
}: ScoutOnboardingMessageProps) {
  const { goChannel } = useAppNavigation();
  const { activeCommunity } = useCommunities();
  const identity = useIdentityQuery().data;
  const relayUrl = activeCommunity?.relayUrl;
  const hasScoutRootMarker = Boolean(parseScoutOnboardingRoot(message.tags));
  const rootQuery = useQuery({
    queryKey: scoutOnboardingRootQueryKey(relayUrl, message.id),
    queryFn: () => getEventById(message.id),
    enabled: Boolean(
      relayUrl && message.id && hasScoutRootMarker && !rootEvent,
    ),
    staleTime: 30_000,
    retry: false,
  });
  const verified = React.useMemo(() => {
    if (!isUsableIdentity(identity)) return null;
    return getVerifiedScoutOnboardingMount({
      activeRelayUrl: relayUrl,
      channelId,
      currentPubkey,
      identityPubkey: identity.pubkey,
      message,
      rootEvent: rootEvent ?? rootQuery.data,
    });
  }, [
    channelId,
    currentPubkey,
    identity,
    message,
    relayUrl,
    rootEvent,
    rootQuery.data,
  ]);
  const continueInWelcome = React.useCallback(() => {
    if (onContinueInWelcome) {
      onContinueInWelcome();
      return;
    }
    const welcomeChannelId = verified?.scope.channelId;
    if (!welcomeChannelId) return;
    void goChannel(welcomeChannelId, { replace: true });
  }, [goChannel, onContinueInWelcome, verified?.scope.channelId]);

  if (!verified) return children;
  return (
    <div
      className="@container min-w-0 w-full"
      data-testid="scout-onboarding-message"
    >
      {children}
      <ScoutOnboardingHost
        className={className}
        initialState={initialState}
        onConfirm={onConfirm}
        onContinueInWelcome={continueInWelcome}
        rootEvent={verified.rootEvent}
        rootPayload={verified.payload}
        runtime={runtime}
        runtimeDependencies={runtimeDependencies}
        scope={verified.scope}
      />
    </div>
  );
}

export default ScoutOnboardingMessage;
