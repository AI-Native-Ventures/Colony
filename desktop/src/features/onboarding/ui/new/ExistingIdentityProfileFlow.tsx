// desktop/src/features/onboarding/ui/new/ExistingIdentityProfileFlow.tsx
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { clearCommunityDestinations } from "@/features/communities/communityNavigationStorage";
import { quarantineLegacyAutoConnectedCommunity } from "@/features/communities/communityStorage";
import { CommunityChangeOverlay } from "@/features/communities/ui/CommunityChangeOverlay";
import { useCommunities } from "@/features/communities/useCommunities";
import {
  checkMembershipStatus,
  isRelayMembershipDeniedError,
} from "@/features/onboarding/membership";
import {
  createProfileUpdatePayload,
  type ProfileDraftValues,
  resolveSavedProfile,
} from "@/features/onboarding/profileDraft";
import { MembershipDenied } from "@/features/onboarding/ui/MembershipDenied";
import {
  profileQueryKey,
  useUpdateProfileMutation,
} from "@/features/profile/hooks";
import { getBuildDefaultRelayUrl } from "@/shared/api/buildConfig";
import { relayClient } from "@/shared/api/relayClient";
import { autoConnectDefaultRelayEnabled } from "@/shared/api/tauri";
import { getIdentity, importIdentity } from "@/shared/api/tauriIdentity";
import type { Profile } from "@/shared/api/types";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";

import { MachineCanvas } from "./MachineCanvas";
import { ProfileScreen } from "./screens/ProfileScreen";

type Props = {
  /** The relay profile this identity already has, when it has one. */
  initialProfile: Profile | null | undefined;
  /** Onboarding is finished: set up starter channels and enter the app. */
  onComplete: () => void;
  /** Leave onboarding without a saved profile, after a failed save. */
  onSkip: () => void;
};

/**
 * Name and photo for a key that already exists but has no relay profile.
 *
 * This is what someone signing in with an existing account, reinstalling, or
 * importing a key reaches. It is deliberately not the founder first run: the
 * identity, the password and the recovery code are already settled, so the
 * only open question is what to call them here.
 */
export function ExistingIdentityProfileFlow({
  initialProfile,
  onComplete,
  onSkip,
}: Props) {
  const { activeCommunity } = useCommunities();
  const queryClient = useQueryClient();
  const profileUpdateMutation = useUpdateProfileMutation();
  const savedProfile = resolveSavedProfile(initialProfile);
  const [draft, setDraft] = React.useState<ProfileDraftValues>(savedProfile);
  const [isSaving, setIsSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [deniedPubkey, setDeniedPubkey] = React.useState<string | null>(null);
  const [isCommunityChangeOpen, setIsCommunityChangeOpen] =
    React.useState(false);

  const updateDraft = React.useCallback(
    (patch: Partial<ProfileDraftValues>) => {
      setSaveError(null);
      setDraft((current) => ({ ...current, ...patch }));
    },
    [],
  );

  /**
   * A relay this build auto-connected to on first launch can refuse the very
   * profile it asked for. Quarantining it and reloading puts the person back
   * on the community choice rather than on a denial they cannot act on.
   */
  const recoverLegacyDefaultCommunity = React.useCallback(async () => {
    if (!activeCommunity) return false;

    try {
      const [defaultRelayUrl, autoConnectDefaultRelay, identity] =
        await Promise.all([
          getBuildDefaultRelayUrl(),
          autoConnectDefaultRelayEnabled(),
          getIdentity(),
        ]);
      if (!defaultRelayUrl) return false;
      if (
        !quarantineLegacyAutoConnectedCommunity({
          activePubkey: identity.pubkey,
          autoConnectDefaultRelay,
          defaultRelayUrl,
        })
      ) {
        return false;
      }

      relayClient.disconnect();
      clearCommunityDestinations();
      window.location.reload();
      return true;
    } catch {
      return false;
    }
  }, [activeCommunity]);

  const showMembershipDenied = React.useCallback(async () => {
    if (await recoverLegacyDefaultCommunity()) return;
    try {
      const identity = await getIdentity();
      setDeniedPubkey(identity.pubkey);
    } catch {
      setDeniedPubkey("");
    }
  }, [recoverLegacyDefaultCommunity]);

  const save = React.useCallback(async () => {
    if (isSaving || draft.displayName.trim().length === 0) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      // Membership is checked before the write rather than after it fails:
      // on an open relay it costs nothing, and on a gated one it is the
      // difference between a recovery screen and a raw 403.
      const membershipStatus = await checkMembershipStatus();
      if (membershipStatus === "denied") {
        await showMembershipDenied();
        return;
      }
      if (membershipStatus === "unreachable") {
        setSaveError(
          "Can't reach this relay. Check your connection, or change your community.",
        );
        return;
      }
      if (membershipStatus === "error") {
        setSaveError("The relay returned an error. Try again.");
        return;
      }

      const updatePayload = createProfileUpdatePayload({
        draftProfile: draft,
        savedProfile,
      });
      if (Object.keys(updatePayload).length > 0) {
        try {
          await profileUpdateMutation.mutateAsync(updatePayload);
        } catch (error) {
          if (isRelayMembershipDeniedError(error)) {
            await showMembershipDenied();
            return;
          }
          setSaveError(
            error instanceof Error
              ? error.message
              : "Could not save your profile.",
          );
          return;
        }
      }

      onComplete();
    } finally {
      setIsSaving(false);
    }
  }, [
    draft,
    isSaving,
    onComplete,
    profileUpdateMutation,
    savedProfile,
    showMembershipDenied,
  ]);

  const importExistingKey = React.useCallback(
    async (nsec: string, password?: string) => {
      const identity = await importIdentity(nsec, password);
      relayClient.disconnect();
      queryClient.setQueryData(["identity"], identity);
      queryClient.removeQueries({ queryKey: profileQueryKey });
      profileUpdateMutation.reset();
      setDeniedPubkey(null);
    },
    [profileUpdateMutation, queryClient],
  );

  if (deniedPubkey !== null) {
    return (
      <>
        <MembershipDenied
          activeRelayUrl={activeCommunity?.relayUrl ?? ""}
          onBack={() => setDeniedPubkey(null)}
          onChangeCommunity={() => setIsCommunityChangeOpen(true)}
          onImportKey={importExistingKey}
          onRetry={() => {
            setDeniedPubkey(null);
            void save();
          }}
          pubkey={deniedPubkey}
        />
        {isCommunityChangeOpen ? (
          <CommunityChangeOverlay
            onClose={() => setIsCommunityChangeOpen(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <MachineCanvas showStep={false} step="identity" testId="onboarding-gate">
      <StartupWindowDragRegion />
      <ProfileScreen
        error={saveError}
        isSaving={isSaving}
        onChange={updateDraft}
        // Recovery from a failed save, exactly as before: someone whose relay
        // already knows a name for them can carry on with it, and someone
        // with no saved name at all can leave and set one from Profile.
        onContinueWithoutSaving={
          saveError && savedProfile.displayName.length > 0
            ? onComplete
            : undefined
        }
        onSkip={
          saveError && savedProfile.displayName.length === 0
            ? onSkip
            : undefined
        }
        onSubmit={() => void save()}
        values={draft}
      />
    </MachineCanvas>
  );
}
