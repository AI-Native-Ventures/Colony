import * as React from "react";
import { flushSync } from "react-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  profileQueryKey,
  useUpdateProfileMutation,
} from "@/features/profile/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { getMyRelayMembershipLookup } from "@/shared/api/relayMembers";
import { isRelayUnreachableError } from "@/shared/lib/relayError";
import { useIdentityQuery } from "@/shared/api/hooks";
import {
  getIdentity,
  importIdentity,
  persistCurrentIdentity,
} from "@/shared/api/tauriIdentity";
import { useSystemColorScheme } from "@/shared/theme/useSystemColorScheme";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/shared/ui/alert-dialog";
import { buttonVariants, Button } from "@/shared/ui/button";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { AvatarStep } from "./AvatarStep";
import { BackupStep } from "./BackupStep";
import { DownloadKeyStep } from "./DownloadKeyStep";
import {
  resetEncryptedBackupSession,
  useEncryptedBackupSession,
} from "./EncryptedBackupCreator";
import { OnboardingChrome } from "./OnboardingChrome";
import { OnboardingFooterProvider } from "./OnboardingFooter";
import { MembershipDenied } from "./MembershipDenied";
import {
  NostrKeyImportForm,
  type NostrKeyImportStage,
} from "./NostrKeyImportForm";
import { useCommunities } from "@/features/communities/useCommunities";
import { CommunityChangeOverlay } from "@/features/communities/ui/CommunityChangeOverlay";
import { quarantineLegacyAutoConnectedCommunity } from "@/features/communities/communityStorage";
import { clearCommunityDestinations } from "@/features/communities/communityNavigationStorage";
import { autoConnectDefaultRelayEnabled } from "@/shared/api/tauri";
import { getBuildDefaultRelayUrl } from "@/shared/api/buildConfig";
import {
  type OnboardingTransitionDirection,
  OnboardingSlideTransition,
} from "./OnboardingSlideTransition";
import { ProfileStep } from "./ProfileStep";
import type {
  OnboardingActions,
  OnboardingPage,
  OnboardingProfileSeed,
  OnboardingProfileValues,
  ProfileStepState,
} from "./types";

function isRelayMembershipDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("You must be a relay member") ||
    error.message.includes("relay_membership_required") ||
    error.message.includes("restricted: not a relay member") ||
    error.message.includes("invalid: you are not a relay member")
  );
}

type MembershipCheckResult = "denied" | "ok" | "unreachable" | "error";

async function checkMembershipStatus(): Promise<MembershipCheckResult> {
  try {
    const { membership, snapshotFound } = await getMyRelayMembershipLookup();
    if (snapshotFound && membership === null) return "denied";
    return "ok";
  } catch (error) {
    if (isRelayMembershipDeniedError(error)) return "denied";
    // Native Tauri commands report connectivity failures with the stable
    // "relay unreachable:" prefix (see desktop/src-tauri/src/relay.rs), which
    // the legacy browser-fetch substrings below do not match.
    if (isRelayUnreachableError(error)) return "unreachable";
    if (error instanceof Error) {
      const msg = error.message.toLowerCase();
      if (
        msg.includes("failed to fetch") ||
        msg.includes("networkerror") ||
        msg.includes("timeout") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound") ||
        msg.includes("connection") ||
        msg.includes("aborted")
      ) {
        return "unreachable";
      }
    }
    return "error";
  }
}

type OnboardingFlowProps = {
  actions: OnboardingActions;
  identityLost?: boolean;
  initialProfile: OnboardingProfileSeed;
};

/** The three views of the key-backup ceremony page. */
type BackupSubview = "main" | "options" | "password";

function isFallbackDisplayName(value?: string | null) {
  const normalizedValue = value?.trim().toLowerCase() ?? "";
  return (
    normalizedValue.startsWith("npub1") ||
    normalizedValue.startsWith("nostr:npub1")
  );
}

function sanitizeDisplayName(value?: string | null) {
  const trimmedValue = value?.trim() ?? "";
  return isFallbackDisplayName(trimmedValue) ? "" : trimmedValue;
}

function resolveSavedProfile({
  profile,
}: OnboardingProfileSeed): OnboardingProfileValues {
  return {
    avatarUrl: profile?.avatarUrl ?? "",
    displayName: sanitizeDisplayName(profile?.displayName),
  };
}

function createProfileUpdatePayload({
  draftProfile,
  savedProfile,
}: {
  draftProfile: OnboardingProfileValues;
  savedProfile: OnboardingProfileValues;
}) {
  const nextDisplayName = draftProfile.displayName.trim();
  const nextAvatarUrl = draftProfile.avatarUrl.trim();
  const updatePayload: {
    avatarUrl?: string;
    displayName?: string;
  } = {};

  if (
    nextDisplayName.length > 0 &&
    nextDisplayName !== savedProfile.displayName
  ) {
    updatePayload.displayName = nextDisplayName;
  }

  if (nextAvatarUrl.length > 0 && nextAvatarUrl !== savedProfile.avatarUrl) {
    updatePayload.avatarUrl = nextAvatarUrl;
  }

  return updatePayload;
}

function resolveProfileSaveRecovery(
  errorMessage: string | null,
  savedDisplayName: string,
): ProfileStepState["saveRecovery"] {
  return {
    canAdvanceWithoutSaving:
      errorMessage !== null && savedDisplayName.length > 0,
    canSkipForNow: errorMessage !== null && savedDisplayName.length === 0,
    errorMessage,
  };
}

export function OnboardingFlow({
  actions,
  identityLost = false,
  initialProfile,
}: OnboardingFlowProps) {
  const { complete } = actions;
  const { activeCommunity } = useCommunities();
  const queryClient = useQueryClient();
  const { data: identity } = useIdentityQuery();
  const savedProfile = resolveSavedProfile(initialProfile);
  const profileUpdateMutation = useUpdateProfileMutation();
  const { error: profileSaveError, isPending: isSavingProfile } =
    profileUpdateMutation;
  // When identity was lost (keyring cleared after migration), land the user
  // directly on the import step with a recovery notice rather than profile setup.
  const [currentPage, setCurrentPage] = React.useState<OnboardingPage>(
    identityLost ? "key-import" : "profile",
  );
  const [keyImportStage, setKeyImportStage] =
    React.useState<NostrKeyImportStage>("key-entry");
  const [isKeyImporting, setIsKeyImporting] = React.useState(false);
  const [keyImportFormKey, setKeyImportFormKey] = React.useState(0);
  const [profileDraft, setProfileDraft] =
    React.useState<OnboardingProfileValues>(savedProfile);
  const [deniedPubkey, setDeniedPubkey] = React.useState<string>("");
  const [persistError, setPersistError] = React.useState<string | null>(null);
  const [isUploadingAvatar, setIsUploadingAvatar] = React.useState(false);
  const [isProfileAdvancePending, setIsProfileAdvancePending] =
    React.useState(false);
  const [membershipRetryPage, setMembershipRetryPage] = React.useState<
    OnboardingPage | "complete"
  >("avatar");
  const [deniedFromPage, setDeniedFromPage] =
    React.useState<OnboardingPage>("profile");
  const [isCommunityChangeOpen, setIsCommunityChangeOpen] =
    React.useState(false);
  const [membershipError, setMembershipError] = React.useState<{
    kind: "unreachable" | "error";
    message?: string;
  } | null>(null);
  const [transitionDirection, setTransitionDirection] =
    React.useState<OnboardingTransitionDirection>("forward");
  // Key-backup ceremony state, composed exactly like MachineOnboardingFlow:
  // the flow owns the encrypted-backup session so progress survives moving
  // between the key view, the options view, and the password subview.
  const [backupSubview, setBackupSubview] =
    React.useState<BackupSubview>("main");
  const [backupDirection, setBackupDirection] =
    React.useState<OnboardingTransitionDirection>("forward");
  const backupSession = useEncryptedBackupSession();
  const [isBackupAckOpen, setIsBackupAckOpen] = React.useState(false);
  const systemColorScheme = useSystemColorScheme();

  const resetProfileSaveError = React.useCallback(() => {
    profileUpdateMutation.reset();
  }, [profileUpdateMutation]);

  const updateProfileDraft = React.useCallback(
    (patch: Partial<OnboardingProfileValues>) => {
      resetProfileSaveError();
      setProfileDraft((current) => ({
        ...current,
        ...patch,
      }));
    },
    [resetProfileSaveError],
  );

  const showProfilePage = React.useCallback(() => {
    setMembershipError(null);
    setTransitionDirection("backward");
    setCurrentPage("profile");
  }, []);

  const showAvatarPage = React.useCallback(() => {
    setTransitionDirection("forward");
    setCurrentPage("avatar");
  }, []);

  const showBackupPage = React.useCallback(() => {
    setBackupDirection("forward");
    setBackupSubview("main");
    setTransitionDirection("forward");
    setCurrentPage("backup");
  }, []);

  const showKeyImportPage = React.useCallback(() => {
    setTransitionDirection("forward");
    setCurrentPage("key-import");
  }, []);

  const recoverLegacyDefaultCommunity = React.useCallback(async () => {
    if (!activeCommunity) {
      return false;
    }

    try {
      const [defaultRelayUrl, autoConnectDefaultRelay, identity] =
        await Promise.all([
          getBuildDefaultRelayUrl(),
          autoConnectDefaultRelayEnabled(),
          getIdentity(),
        ]);
      if (!defaultRelayUrl) {
        return false;
      }
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

  const showMembershipDenied = React.useCallback(
    async (nextPage: OnboardingPage | "complete") => {
      if (await recoverLegacyDefaultCommunity()) {
        return;
      }

      try {
        const identity = await getIdentity();
        setDeniedPubkey(identity.pubkey);
      } catch {
        setDeniedPubkey("");
      }
      setDeniedFromPage((prev) =>
        currentPage === "membership-denied" ? prev : currentPage,
      );
      setMembershipRetryPage(nextPage);
      setCurrentPage("membership-denied");
    },
    [currentPage, recoverLegacyDefaultCommunity],
  );

  const saveProfileAndContinue = React.useCallback(
    async (nextPage: OnboardingPage | "complete") => {
      if (isProfileAdvancePending) {
        return;
      }
      if (profileDraft.displayName.trim().length === 0) {
        return;
      }

      flushSync(() => {
        setIsProfileAdvancePending(true);
      });

      try {
        // Check membership before attempting the profile save. On open relays
        // this passes instantly. On gated relays it prevents a 403 during save.
        const membershipStatus = await checkMembershipStatus();
        setMembershipError(null);

        if (membershipStatus === "denied") {
          await showMembershipDenied(nextPage);
          return;
        }

        if (membershipStatus === "unreachable") {
          setMembershipError({ kind: "unreachable" });
          return;
        }

        if (membershipStatus === "error") {
          setMembershipError({
            kind: "error",
            message: "Server error, try again",
          });
          return;
        }

        const updatePayload = createProfileUpdatePayload({
          draftProfile: profileDraft,
          savedProfile,
        });

        if (Object.keys(updatePayload).length > 0) {
          try {
            await profileUpdateMutation.mutateAsync(updatePayload);
          } catch (error) {
            if (isRelayMembershipDeniedError(error)) {
              await showMembershipDenied(nextPage);
              return;
            }

            // Error falls through to the error banner / recovery buttons.
            return;
          }
        }

        if (nextPage === "complete") {
          complete();
          return;
        }
        if (nextPage === "backup") {
          showBackupPage();
          return;
        }
        showAvatarPage();
      } finally {
        setIsProfileAdvancePending(false);
      }
    },
    [
      isProfileAdvancePending,
      profileDraft,
      profileUpdateMutation,
      savedProfile,
      complete,
      showMembershipDenied,
      showAvatarPage,
      showBackupPage,
    ],
  );

  const updateDisplayNameDraft = React.useCallback(
    (value: string) => {
      updateProfileDraft({ displayName: value });
    },
    [updateProfileDraft],
  );

  const updateAvatarUrlDraft = React.useCallback(
    (value: string) => {
      updateProfileDraft({ avatarUrl: value });
    },
    [updateProfileDraft],
  );

  const resetAvatarDraft = React.useCallback(() => {
    updateProfileDraft({ avatarUrl: savedProfile.avatarUrl });
  }, [savedProfile.avatarUrl, updateProfileDraft]);

  const advanceFromProfileWithoutSaving = React.useCallback(() => {
    profileUpdateMutation.reset();
    setProfileDraft((current) => ({
      ...current,
      displayName: savedProfile.displayName,
    }));
    showAvatarPage();
  }, [profileUpdateMutation, savedProfile.displayName, showAvatarPage]);

  const returnToBackupMain = React.useCallback(() => {
    setBackupDirection("backward");
    setBackupSubview("main");
  }, []);

  const openBackupPasswordSubview = React.useCallback(() => {
    // Mirror MachineOnboardingFlow: entering the password flow starts from a
    // clean session so a stale passphrase or test progress never carries in.
    resetEncryptedBackupSession(backupSession);
    setBackupDirection("forward");
    setBackupSubview("password");
  }, [backupSession]);

  // The exact signal PrivateKeyBackupRow / EncryptedBackupCreator use: a
  // session with a committed-and-saved blob (or a passed backup test) means
  // the user already holds a recovery artifact this run.
  const hasSavedKeyBackup = backupSession.created || backupSession.verified;

  const saveErrorMessage =
    profileSaveError instanceof Error ? profileSaveError.message : null;
  const profileStepState: ProfileStepState = {
    avatar: {
      draftUrl: profileDraft.avatarUrl,
      savedUrl: savedProfile.avatarUrl,
    },
    isUploadingAvatar,
    isSaving: isSavingProfile || isProfileAdvancePending,
    name: {
      draftValue: profileDraft.displayName,
      savedValue: savedProfile.displayName,
    },
    saveRecovery: resolveProfileSaveRecovery(
      saveErrorMessage,
      savedProfile.displayName,
    ),
  };
  const avatarStepState: ProfileStepState = {
    ...profileStepState,
    saveRecovery: saveErrorMessage
      ? {
          canAdvanceWithoutSaving: true,
          canSkipForNow: false,
          errorMessage: saveErrorMessage,
        }
      : profileStepState.saveRecovery,
  };
  // Machine-level identity and provider setup have already completed. This
  // relay-scoped flow owns the community profile plus the key-backup
  // ceremony: profile → avatar → backup.
  const activeSteps: OnboardingPage[] = ["profile", "avatar", "backup"];
  const STEP_OFFSET = 1;
  // key-import occupies the same position as profile.
  const normalizedPage: OnboardingPage =
    currentPage === "key-import" ? "profile" : currentPage;
  const pageIndex = activeSteps.indexOf(normalizedPage);
  const currentStep = pageIndex >= 0 ? pageIndex + STEP_OFFSET : STEP_OFFSET;
  const totalOnboardingSteps = activeSteps.length;

  // Swapping the identity changes the pubkey, which remounts this flow
  // (keyed on pubkey in App.tsx) and re-runs the onboarding gate: the new
  // key's relay profile reseeds the steps, and a key that already finished
  // onboarding on this machine skips straight into the app.
  const importExistingKey = React.useCallback(
    async (nsec: string, password?: string) => {
      const identity = await importIdentity(nsec, password);
      relayClient.disconnect();
      queryClient.setQueryData(["identity"], identity);
      queryClient.removeQueries({ queryKey: profileQueryKey });
      profileUpdateMutation.reset();
      setDeniedPubkey("");
      setTransitionDirection("backward");
      setCurrentPage("profile");
    },
    [profileUpdateMutation, queryClient],
  );

  // Lost-mode "start new identity": confirm first (irreversible), then persist
  // the ephemeral key so the new identity is durable, then let the stage
  // machinery (bootedLost + !identityLost) replace this flow with
  // RelaunchRequiredScreen. No navigation needed here.
  const handleLostModeBack = React.useCallback(async () => {
    const confirmed = window.confirm(
      "This will create a new identity and abandon your previous key. This cannot be undone. Continue?",
    );
    if (!confirmed) {
      return;
    }
    try {
      const identity = await persistCurrentIdentity();
      queryClient.setQueryData(["identity"], identity);
    } catch (error) {
      setPersistError(
        error instanceof Error
          ? error.message
          : "Failed to create a new identity. Please try again.",
      );
    }
  }, [queryClient]);

  const handleKeyImportBack = React.useCallback(() => {
    if (keyImportStage === "backup-password") {
      setKeyImportFormKey((current) => current + 1);
      setKeyImportStage("key-entry");
      return;
    }
    if (identityLost) {
      void handleLostModeBack();
      return;
    }
    showProfilePage();
  }, [handleLostModeBack, identityLost, keyImportStage, showProfilePage]);

  const chromeBackAction =
    currentPage === "profile"
      ? {
          disabled: profileStepState.isSaving,
          onClick: () => {
            setMembershipError(null);
            setIsCommunityChangeOpen(true);
          },
        }
      : currentPage === "key-import"
        ? {
            label:
              keyImportStage === "backup-password"
                ? "Back"
                : identityLost
                  ? "Start new identity"
                  : "Back",
            disabled: isKeyImporting,
            onClick: handleKeyImportBack,
          }
        : currentPage === "avatar"
          ? {
              disabled:
                avatarStepState.isSaving || avatarStepState.isUploadingAvatar,
              onClick: showProfilePage,
            }
          : currentPage === "backup"
            ? backupSubview === "main"
              ? {
                  onClick: () => {
                    setTransitionDirection("backward");
                    setCurrentPage("avatar");
                  },
                }
              : {
                  label: "Back",
                  onClick: returnToBackupMain,
                }
            : undefined;

  if (currentPage === "membership-denied") {
    return (
      <>
        <MembershipDenied
          activeRelayUrl={activeCommunity?.relayUrl ?? ""}
          onBack={() => {
            setTransitionDirection("backward");
            setCurrentPage(deniedFromPage);
          }}
          onChangeCommunity={() => setIsCommunityChangeOpen(true)}
          onImportKey={importExistingKey}
          onRetry={() => {
            void saveProfileAndContinue(membershipRetryPage);
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
    <>
      <div
        className={`buzz-onboarding-neutral-theme buzz-startup-shell flex items-start justify-center overflow-y-auto bg-background px-4 pb-28 pt-[106px] text-foreground ${
          currentPage === "backup" && backupSubview === "password"
            ? "buzz-onboarding-security-theme"
            : ""
        }`}
        data-testid="onboarding-gate"
        data-system-color-scheme={systemColorScheme}
      >
        <StartupWindowDragRegion />
        {!(currentPage === "backup" && backupSubview === "password") ? (
          <OnboardingChrome
            current={currentStep}
            total={totalOnboardingSteps}
          />
        ) : null}
        <OnboardingFooterProvider backAction={chromeBackAction}>
          <div
            className={`relative flex w-full flex-col items-center text-center ${
              currentPage === "avatar"
                ? "max-w-[1080px]"
                : currentPage === "backup"
                  ? "max-w-[1040px]"
                  : "max-w-[500px]"
            }`}
          >
            {membershipError &&
            (currentPage === "profile" || currentPage === "avatar") ? (
              <div className="mb-4 w-full max-w-[500px] rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm">
                {membershipError.kind === "unreachable" ? (
                  <>
                    <p className="font-medium text-destructive">
                      Can't reach this relay
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      Check your connection or change your community.
                    </p>
                    <Button
                      className="mt-3"
                      onClick={() => setIsCommunityChangeOpen(true)}
                      size="sm"
                      variant="outline"
                    >
                      Change community
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="font-medium text-destructive">
                      {membershipError.message ?? "Something went wrong"}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      The relay returned an error. Try again.
                    </p>
                  </>
                )}
              </div>
            ) : null}

            {currentPage === "profile" ? (
              <ProfileStep
                actions={{
                  advanceWithoutSaving: advanceFromProfileWithoutSaving,
                  clearAvatarDraft: resetAvatarDraft,
                  importExistingKey: showKeyImportPage,
                  onUploadingChange: setIsUploadingAvatar,
                  // Error recovery no longer exits onboarding: every path out
                  // now passes through the key-backup step.
                  skipForNow: showBackupPage,
                  submit: () => {
                    void saveProfileAndContinue("avatar");
                  },
                  updateAvatarUrl: updateAvatarUrlDraft,
                  updateDisplayName: updateDisplayNameDraft,
                }}
                direction={transitionDirection}
                state={profileStepState}
                usesExistingIdentity
              />
            ) : currentPage === "key-import" ? (
              <OnboardingSlideTransition
                className="flex w-full flex-col items-center text-center"
                direction={transitionDirection}
                transitionKey={`key-import-${transitionDirection}`}
              >
                <div className="w-full max-w-[440px]">
                  {identityLost ? (
                    <>
                      <h1 className="text-title font-normal text-foreground">
                        Re-import your key
                      </h1>
                      <p className="mt-5 text-sm leading-6 text-muted-foreground">
                        Your identity is no longer in the system keyring.
                        Re-import your nsec to restore it, Colony will restart
                        to finish recovery. Or go back to start a new identity
                        with a fresh key.
                      </p>
                    </>
                  ) : (
                    <>
                      <h1 className="text-title font-normal text-foreground">
                        Use your existing key
                      </h1>
                      <p className="mt-5 text-sm leading-6 text-muted-foreground">
                        Import your Nostr private key to use that identity with
                        Colony. If this key already has a profile on the relay,
                        your name and avatar are restored automatically.
                      </p>
                    </>
                  )}
                </div>

                {persistError ? (
                  <p className="mt-4 w-full max-w-[440px] text-sm text-destructive">
                    {persistError}
                  </p>
                ) : null}

                <NostrKeyImportForm
                  key={keyImportFormKey}
                  onBack={handleKeyImportBack}
                  onImport={importExistingKey}
                  onImportingChange={setIsKeyImporting}
                  onStageChange={setKeyImportStage}
                  showBack={false}
                  showPasswordStageBack={false}
                />
              </OnboardingSlideTransition>
            ) : currentPage === "backup" ? (
              backupSubview === "password" ? (
                <DownloadKeyStep
                  direction={backupDirection}
                  onBack={returnToBackupMain}
                  session={backupSession}
                />
              ) : (
                <BackupStep
                  direction={backupDirection}
                  identityStorage={identity?.storage}
                  nextLabel={hasSavedKeyBackup ? "Finish" : "Continue"}
                  onNext={
                    hasSavedKeyBackup
                      ? complete
                      : () => setIsBackupAckOpen(true)
                  }
                  onOpenPasswordBackup={openBackupPasswordSubview}
                  onShowOptions={() => {
                    setBackupDirection("forward");
                    setBackupSubview("options");
                  }}
                  optionsExpanded={backupSubview === "options"}
                  returningFromSecurity={false}
                />
              )
            ) : (
              <AvatarStep
                actions={{
                  // Every avatar exit leads to the key-backup step; only the
                  // backup ceremony (or its explicit acknowledgement) ends
                  // onboarding.
                  advanceWithoutSaving: showBackupPage,
                  back: showProfilePage,
                  onUploadingChange: setIsUploadingAvatar,
                  skipForNow: showBackupPage,
                  submit: () => {
                    void saveProfileAndContinue("backup");
                  },
                  updateAvatarUrl: updateAvatarUrlDraft,
                }}
                direction={transitionDirection}
                showAlwaysSkip={true}
                showBack={false}
                state={avatarStepState}
              />
            )}
          </div>
        </OnboardingFooterProvider>
      </div>
      {isCommunityChangeOpen ? (
        <CommunityChangeOverlay
          onClose={() => setIsCommunityChangeOpen(false)}
        />
      ) : null}
      <AlertDialog
        onOpenChange={setIsBackupAckOpen}
        open={currentPage === "backup" && isBackupAckOpen}
      >
        <AlertDialogContent
          className="buzz-onboarding-neutral-theme"
          data-testid="onboarding-backup-ack-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Continue without a backup?</AlertDialogTitle>
            <AlertDialogDescription>
              Your account is protected by a single key that lives only on this
              device. If you lose this device, your account and company cannot
              be recovered. Colony cannot restore it for you.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="onboarding-backup-ack-cancel">
              Back up my key
            </AlertDialogCancel>
            <AlertDialogAction
              className={buttonVariants({ variant: "destructive" })}
              data-testid="onboarding-backup-ack-confirm"
              onClick={() => {
                setIsBackupAckOpen(false);
                complete();
              }}
            >
              Continue without a backup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
