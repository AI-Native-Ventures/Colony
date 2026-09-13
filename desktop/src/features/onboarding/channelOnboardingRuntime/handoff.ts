import {
  createScoutOnboardingRootPayload,
  type ScoutOnboardingRootPayload,
  type ScoutOnboardingRootSeedInput,
  type ScoutOnboardingRootScope,
} from "./protocol";

export type ScoutInitialChannelInitResult = {
  ok: boolean;
  reason?: string;
  focusChannelId?: string;
};

export type ScoutInitialHandoffInput = {
  queryClient: unknown;
  ownerPubkey: string;
  relayUrl: string;
  /** Stable signup marker. It is the root's retry authority. */
  requestId: string;
  seed: ScoutOnboardingRootSeedInput;
  assertCurrent?: () => void;
  /** Personal profile fields may be saved after the channel exists. */
  profile?: {
    displayName?: string | null;
    avatarUrl?: string | null;
    displayNameIfMissing?: boolean;
  };
};

export type ScoutInitialHandoffIo = {
  markExplicitHandoff(
    scope: Pick<ScoutOnboardingRootScope, "ownerPubkey" | "relayUrl">,
  ): Promise<void>;
  initializeStarterChannels(
    queryClient: unknown,
    args: {
      focus: true;
      pubkey: string;
      communityScope: string;
      /** Root delivery must not seed Scout or the Welcome canvas. */
      seedWelcomeExperience: false;
    },
  ): Promise<ScoutInitialChannelInitResult>;
  updateProfile?: (
    input: { displayName?: string; avatarUrl?: string },
    context: {
      queryClient: unknown;
      relayUrl: string;
      pubkey: string;
      assertCurrent?: () => void;
      profileDisplayNameIfMissing?: boolean;
    },
  ) => Promise<unknown>;
  deliverRoot(
    payload: ScoutOnboardingRootPayload,
  ): Promise<{ eventId: string }>;
  takePendingWelcomeChannelForDirectEntry(): void;
  navigateToChannel(channelId: string): void;
  navigateToThread?(channelId: string, eventId: string): void;
};

function assertEventId(eventId: string) {
  if (!/^[a-f0-9]{64}$/.test(eventId)) {
    throw new Error("The signup root could not be verified. Retry setup.");
  }
}

function profileInput(profile: ScoutInitialHandoffInput["profile"]) {
  const displayName = profile?.displayName?.trim();
  const avatarUrl = profile?.avatarUrl?.trim();
  return {
    ...(displayName ? { displayName } : {}),
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

/** Open Welcome and deliver the owner-signed context without starting work. */
export async function startScoutOnboardingHandoff(
  input: ScoutInitialHandoffInput,
  io: ScoutInitialHandoffIo,
): Promise<{ focusChannelId: string; rootEventId: string }> {
  input.assertCurrent?.();
  await io.markExplicitHandoff({
    ownerPubkey: input.ownerPubkey,
    relayUrl: input.relayUrl,
  });
  input.assertCurrent?.();

  const channels = await io.initializeStarterChannels(input.queryClient, {
    focus: true,
    pubkey: input.ownerPubkey,
    communityScope: input.relayUrl,
    seedWelcomeExperience: false,
  });
  input.assertCurrent?.();
  if (!channels.focusChannelId) {
    throw new Error(
      channels.reason ?? "The Welcome channel is not ready. Retry setup.",
    );
  }
  const focusChannelId = channels.focusChannelId;

  const profile = profileInput(input.profile);
  if (Object.keys(profile).length > 0) {
    if (!io.updateProfile) {
      throw new Error("Your profile could not be saved. Retry setup.");
    }
    await io.updateProfile(profile, {
      queryClient: input.queryClient,
      relayUrl: input.relayUrl,
      pubkey: input.ownerPubkey,
      assertCurrent: input.assertCurrent,
      profileDisplayNameIfMissing: input.profile?.displayNameIfMissing,
    });
    input.assertCurrent?.();
  }

  input.assertCurrent?.();
  io.takePendingWelcomeChannelForDirectEntry();
  io.navigateToChannel(focusChannelId);

  const scope: ScoutOnboardingRootScope = {
    ownerPubkey: input.ownerPubkey,
    relayUrl: input.relayUrl,
    channelId: focusChannelId,
    requestId: input.requestId,
  };
  const payload = createScoutOnboardingRootPayload(scope, input.seed);
  const sent = await io.deliverRoot(payload);
  input.assertCurrent?.();
  assertEventId(sent.eventId);
  io.navigateToThread?.(focusChannelId, sent.eventId);
  return { focusChannelId, rootEventId: sent.eventId };
}
