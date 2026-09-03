import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ensureAutomaticAgentConfig } from "@/features/onboarding/automaticAgentSetup";
import {
  isOwnerLedCommunityOnboarding,
  markCommunityOnboardingComplete,
  useCommunityOnboarding,
} from "@/features/onboarding/communityOnboarding";
import { useClaimInvite } from "@/features/onboarding/useClaimInvite";
import { CommunityChangeOverlay } from "@/features/communities/ui/CommunityChangeOverlay";
import { WELCOME_SURFACE_READY_EVENT } from "@/features/onboarding/welcome";
import { useAvatarPresentation } from "@/features/profile/avatarPresentationStore";
import { registerAvatarWhenReady } from "@/features/profile/avatarProfileSync";
import { profileQueryKey } from "@/features/profile/hooks";
import { ProfileAvatar } from "@/features/profile/ui/ProfileAvatar";
import { getProfile, updateProfile } from "@/shared/api/tauriProfiles";
import { getIdentity, importIdentity } from "@/shared/api/tauriIdentity";
import { listPersonas } from "@/shared/api/tauriPersonas";
import {
  STARTER_PERSONA_ORDER,
  starterPersonaAnimation,
} from "@/shared/constants/starterPersonas";
import { relayClient } from "@/shared/api/relayClient";
import type { AgentPersona } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { MembershipDenied } from "./MembershipDenied";
import { MachineCanvas } from "./new/MachineCanvas";
import { ProfileScreen } from "./new/screens/ProfileScreen";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";
import { OnboardingV2Flow } from "./OnboardingV2Flow";
import { completeFirstRun } from "../flow/completeFirstRun";
import { DEFAULT_COMPLETE_FIRST_RUN_IO } from "../flow/completeFirstRunIo";

function isRelayMembershipDeniedError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("You must be a relay member") ||
    error.message.includes("relay_membership_required") ||
    error.message.includes("restricted: not a relay member") ||
    error.message.includes("invalid: you are not a relay member")
  );
}

/** Fade duration for the "entering" curtain over the mounting app. */
const ENTERING_CURTAIN_FADE_MS = 500;
/**
 * Safety valve: if Welcome never reports ready (slow relay, failed query),
 * fade anyway rather than stranding the user on the onboarding screen.
 */
const ENTERING_CURTAIN_MAX_WAIT_MS = 8_000;

/**
 * Hard deadline for the Scout handoff (channel creation + first-task
 * delivery) against a possibly brand-new relay. Bounded failure with Retry
 * and Skip beats an eternal "Bringing Scout online…".
 */
const FINALIZE_TIMEOUT_MS = 15_000;

function LoadingDots({ label }: { label: string }) {
  return (
    <span
      aria-label={label}
      className="inline-flex items-center justify-center gap-1"
      data-testid="community-team-intro-loading-dots"
      role="status"
    >
      {[0, 1, 2].map((index) => (
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-none"
          key={index}
          style={{ animationDelay: `${index * 120}ms` }}
        />
      ))}
    </span>
  );
}

export function CommunityOnboardingFlow({
  onCancel,
  onConnect,
}: {
  onCancel: () => void;
  onConnect: () => void;
}) {
  const { transaction, update, clear } = useCommunityOnboarding();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = React.useState("");
  const [avatarUrl, setAvatarUrl] = React.useState("");
  const avatarPresentation = useAvatarPresentation(avatarUrl);
  const [starterPersonas, setStarterPersonas] = React.useState<AgentPersona[]>(
    [],
  );
  const [isPending, setIsPending] = React.useState(false);
  const [starterChannelFailureCount, setStarterChannelFailureCount] =
    React.useState(0);
  const [deniedPubkey, setDeniedPubkey] = React.useState("");
  const [isMembershipDenied, setIsMembershipDenied] = React.useState(false);
  const [isCommunityChangeOpen, setIsCommunityChangeOpen] =
    React.useState(false);
  const [isCurtainFading, setIsCurtainFading] = React.useState(false);
  const loadedProfileAvatarUrlRef = React.useRef("");

  // Also fetch on "entering": the curtain is a fresh mount of this component,
  // so the team-intro fetch from the pre-curtain instance isn't in this state.
  const isTeamIntroVisible =
    transaction?.stage === "team-intro" ||
    transaction?.stage === "finalizing" ||
    transaction?.stage === "entering";
  React.useEffect(() => {
    if (!isTeamIntroVisible) return;
    void listPersonas()
      .then((personas) =>
        setStarterPersonas(
          STARTER_PERSONA_ORDER.flatMap((personaId) => {
            const persona = personas.find(
              (candidate) => candidate.id === personaId,
            );
            return persona ? [persona] : [];
          }),
        ),
      )
      .catch(() => setStarterPersonas([]));
  }, [isTeamIntroVisible]);

  useClaimInvite();

  React.useEffect(() => {
    if (transaction?.stage === "connecting") onConnect();
  }, [onConnect, transaction?.stage]);

  // "Entering" curtain: the app is mounting on the Welcome route underneath.
  // Fade out when Welcome reports its first settled render — or after a
  // safety timeout so a slow load can never strand the user on this screen.
  const isEnteringStage = transaction?.stage === "entering";
  React.useEffect(() => {
    if (!isEnteringStage) return;

    let fadeTimer: number | null = null;
    const beginFade = () => {
      if (fadeTimer !== null) return;
      setIsCurtainFading(true);
      fadeTimer = window.setTimeout(() => {
        clear();
      }, ENTERING_CURTAIN_FADE_MS);
    };

    window.addEventListener(WELCOME_SURFACE_READY_EVENT, beginFade);
    const safetyTimer = window.setTimeout(
      beginFade,
      ENTERING_CURTAIN_MAX_WAIT_MS,
    );
    return () => {
      window.removeEventListener(WELCOME_SURFACE_READY_EVENT, beginFade);
      window.clearTimeout(safetyTimer);
      if (fadeTimer !== null) window.clearTimeout(fadeTimer);
    };
  }, [clear, isEnteringStage]);

  const retry = () =>
    update({
      stage: transaction?.inviteCode ? "claiming" : "connecting",
      error: undefined,
    });
  const relayUrl = transaction?.relayUrl;
  const isOwnerLed = transaction
    ? isOwnerLedCommunityOnboarding(transaction)
    : false;

  // Whether this machine has an agent path is what decides which of its two
  // openings the Welcome kickoff posts, so the config has to be written before
  // the app mounts on Welcome. It starts as soon as the team screen appears,
  // and `finalize` awaits whatever is in flight, so someone who clicks
  // straight through cannot outrun it.
  const agentSetupRef = React.useRef<Promise<unknown> | null>(null);
  const startAgentSetup = React.useCallback(() => {
    if (!agentSetupRef.current) {
      agentSetupRef.current = ensureAutomaticAgentConfig().catch((error) => {
        // Setup never blocks entry: an unconfigured machine still lands the
        // user in Colony, and Settings is still there to do it by hand.
        console.warn("Automatic agent setup failed.", error);
      });
    }
    return agentSetupRef.current;
  }, []);
  React.useEffect(() => {
    if (!isTeamIntroVisible || !isOwnerLed) return;
    void startAgentSetup();
  }, [isOwnerLed, isTeamIntroVisible, startAgentSetup]);
  const finish = React.useCallback(async () => {
    if (!relayUrl) return;
    const identity = await getIdentity();
    markCommunityOnboardingComplete(identity.pubkey, relayUrl);
    clear();
  }, [clear, relayUrl]);
  const finalize = React.useCallback(async () => {
    if (isPending || !relayUrl) return;
    setIsPending(true);
    update({ stage: "finalizing", error: undefined });
    // The handoff talks to a possibly brand-new relay. Without a deadline a
    // relay that never answers leaves the user on "Bringing Scout online…"
    // forever with no error and no way forward — the exact trap this guard
    // exists for. On timeout the catch below surfaces Retry / Skip for now.
    const deadline = new Promise<never>((_, reject) => {
      window.setTimeout(
        () =>
          reject(
            new Error("Scout setup timed out. Try again or skip for now."),
          ),
        FINALIZE_TIMEOUT_MS,
      );
    });
    try {
      const work = (async () => {
        // Before the channels exist, so it is settled before the kickoff runs.
        if (isOwnerLed) await startAgentSetup();
        const identity = await getIdentity();
        // A resumed transaction whose brief already went out keeps its
        // recorded id and must not re-check the marker; passing draft: null
        // preserves that exactly.
        const draft = transaction?.onboardingV2 ?? null;
        const alreadyDelivered = Boolean(draft?.firstTask.deliveredEventId);
        const completion = await completeFirstRun(
          {
            queryClient,
            relayUrl,
            pubkey: identity.pubkey,
            draft: alreadyDelivered ? null : draft,
            // The legacy profile stage already published kind:0.
            profileDisplayName: null,
            // This path already wrote the profile, avatar included, on its own
            // profile stage; completion must not publish a second kind:0.
            profileAvatarUrl: null,
          },
          DEFAULT_COMPLETE_FIRST_RUN_IO,
        );
        if (completion.focusChannelId) {
          let onboardingV2 = transaction?.onboardingV2;
          if (onboardingV2 && completion.firstTaskEventId) {
            onboardingV2 = {
              ...onboardingV2,
              firstTask: {
                ...onboardingV2.firstTask,
                deliveredEventId: completion.firstTaskEventId,
              },
            };
          }
          // Keep this screen mounted as a curtain over the loading app; the
          // "entering" stage fades it out once Welcome reports ready.
          update({
            stage: "entering",
            error: undefined,
            onboardingV2: onboardingV2
              ? { ...onboardingV2, stage: "entering" }
              : undefined,
          });
          return;
        }
        await finish();
      })();
      await Promise.race([work, deadline]);
    } catch (error) {
      setStarterChannelFailureCount((count) => count + 1);
      update({
        error: error instanceof Error ? error.message : String(error),
      });
      setIsPending(false);
    }
  }, [
    finish,
    isOwnerLed,
    isPending,
    queryClient,
    relayUrl,
    startAgentSetup,
    transaction?.onboardingV2,
    update,
  ]);

  const backToProfile = React.useCallback(() => {
    if (isPending) return;
    setStarterChannelFailureCount(0);
    update({ stage: "profile", error: undefined });
  }, [isPending, update]);

  const isProfileStage = transaction?.stage === "profile";
  const isTeamStage =
    transaction?.stage === "team-intro" ||
    transaction?.stage === "finalizing" ||
    transaction?.stage === "entering";

  // Seed display name and avatar from the relay profile when the profile step
  // is shown. This covers the case where the skip raced or was bypassed (e.g.,
  // the user navigated Back). Only seeds fields that are still empty so that
  // any user edits are preserved.
  React.useEffect(() => {
    if (!isProfileStage) return;
    loadedProfileAvatarUrlRef.current = "";
    void getProfile()
      .then((profile) => {
        loadedProfileAvatarUrlRef.current = profile.avatarUrl?.trim() ?? "";
        if (profile.displayName) {
          setDisplayName((prev) =>
            prev === "" ? (profile.displayName ?? "") : prev,
          );
        }
        if (profile.avatarUrl) {
          setAvatarUrl((prev) =>
            prev === "" ? (profile.avatarUrl ?? "") : prev,
          );
        }
      })
      .catch(() => {
        // Seeding is best-effort; silently ignore failures.
      });
  }, [isProfileStage]);

  if (!transaction) return null;

  if (isMembershipDenied) {
    return (
      <>
        <MembershipDenied
          activeRelayUrl={transaction.relayUrl}
          onBack={() => setIsMembershipDenied(false)}
          onChangeCommunity={() => setIsCommunityChangeOpen(true)}
          onImportKey={async (nsec) => {
            const identity = await importIdentity(nsec);
            relayClient.disconnect();
            queryClient.setQueryData(["identity"], identity);
            queryClient.removeQueries({ queryKey: profileQueryKey });
            setIsMembershipDenied(false);
            update({ stage: "connecting", error: undefined });
          }}
          onRetry={() => {
            setIsMembershipDenied(false);
            update({ stage: "connecting", error: undefined });
          }}
          pubkey={deniedPubkey}
        />
        {isCommunityChangeOpen ? (
          <CommunityChangeOverlay
            onClose={() => setIsCommunityChangeOpen(false)}
            onUpdated={(communityName, updatedRelayUrl) => {
              update({
                communityName,
                relayUrl: updatedRelayUrl,
                stage: "connecting",
                error: undefined,
              });
              setIsMembershipDenied(false);
            }}
          />
        ) : null}
      </>
    );
  }

  const saveProfile = async () => {
    if (!displayName.trim()) return;
    setIsPending(true);
    try {
      const candidateAvatarUrl = avatarUrl.trim();
      const presentationState = avatarPresentation?.state;
      const shouldSaveCandidate =
        candidateAvatarUrl.length > 0 &&
        candidateAvatarUrl !== loadedProfileAvatarUrlRef.current &&
        presentationState !== "failed" &&
        presentationState !== "pending";

      const deferredAvatar =
        candidateAvatarUrl && presentationState && presentationState !== "ready"
          ? registerAvatarWhenReady({
              avatarUrl: candidateAvatarUrl,
              relayUrl: transaction.relayUrl,
            })
          : null;

      try {
        const profile = await updateProfile({
          displayName: displayName.trim(),
          avatarUrl: shouldSaveCandidate ? candidateAvatarUrl : undefined,
        });
        deferredAvatar?.release({
          expectedPubkey: profile.pubkey,
          expectedAvatarUrl: profile.avatarUrl,
        });
      } catch (error) {
        deferredAvatar?.cancel();
        throw error;
      }
      update({ stage: "team-intro", error: undefined });
    } catch (error) {
      if (isRelayMembershipDeniedError(error)) {
        try {
          const identity = await getIdentity();
          setDeniedPubkey(identity.pubkey);
        } catch {
          setDeniedPubkey("");
        }
        setIsMembershipDenied(true);
        return;
      }
      update({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setIsPending(false);
    }
  };

  // The duplication was only ever in first run: the redesigned flow asks for
  // the founder's name, country, city and gender there, so showing V2 as well
  // meant answering the same questions twice in one sitting. A returning
  // founder creating a second community never sees the redesigned flow at
  // all, and that journey is V2's alone, so it still renders here. The draft
  // is the brief's payload on this path; the canvas first run builds its own
  // from the flow answers and delivers it through the same shared module.
  const isReturningFounderJourney = transaction.source === "create-community";
  if (
    transaction.onboardingV2 &&
    isReturningFounderJourney &&
    transaction.stage !== "claiming" &&
    transaction.stage !== "connecting"
  ) {
    return (
      <OnboardingV2Flow
        draft={transaction.onboardingV2}
        externalError={transaction.error}
        isFinalizing={isPending}
        journey="additional-community"
        onChange={(onboardingV2) => update({ onboardingV2, error: undefined })}
        onReadyToFinalize={finalize}
        onSkip={() => void finish()}
      />
    );
  }

  return (
    <MachineCanvas
      className={cn(
        "z-50",
        isCurtainFading &&
          "pointer-events-none opacity-0 transition-opacity ease-out motion-reduce:transition-none",
      )}
      showStep={false}
      step="identity"
      style={
        isCurtainFading
          ? { transitionDuration: `${ENTERING_CURTAIN_FADE_MS}ms` }
          : undefined
      }
      testId="community-onboarding-flow"
    >
      <StartupWindowDragRegion />
      <div
        className="onb-screen"
        data-solo={!isProfileStage && !isTeamStage}
        data-testid="community-onboarding-body"
      >
        {transaction.stage === "claiming" ||
        transaction.stage === "connecting" ? (
          <div className="onb-hero">
            <div className="onb-col-head">
              <h1 className="onb-headline">
                Joining <em>{transaction.communityName}</em>
              </h1>
              <p className="onb-sub">
                {transaction.error ??
                  (transaction.stage === "claiming"
                    ? "Accepting your invite."
                    : "Connecting securely.")}
              </p>
            </div>
            <div className="onb-actions">
              {transaction.error ? (
                <Button onClick={retry} size="lg">
                  Retry
                </Button>
              ) : null}
              <button
                className="onb-quiet-action"
                onClick={onCancel}
                type="button"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : isProfileStage ? (
          <ProfileScreen
            error={transaction.error ?? null}
            isSaving={isPending}
            onChange={(patch) => {
              if (patch.displayName !== undefined)
                setDisplayName(patch.displayName);
              if (patch.avatarUrl !== undefined) setAvatarUrl(patch.avatarUrl);
            }}
            onBack={onCancel}
            onSubmit={() => void saveProfile()}
            values={{ avatarUrl, displayName }}
          />
        ) : (
          <>
            <div className="onb-col-head">
              <h1 className="onb-headline">
                Meet your <em>starter team</em>.
              </h1>
              <p className="onb-sub">
                Colony lets you bring several agents into one workspace. This
                team is what gets you started.
              </p>
            </div>
            <div className="onb-panel">
              {starterPersonas.length > 0 ? (
                <div className="flex flex-wrap justify-center gap-8">
                  {starterPersonas.map((persona) => {
                    const animationUrl = starterPersonaAnimation(persona.id);
                    return (
                      <div
                        className="flex w-32 flex-col items-center gap-3"
                        key={persona.id}
                      >
                        {animationUrl ? (
                          <img
                            alt={`${persona.displayName} animated character`}
                            className="h-32 w-32 object-contain"
                            data-testid={`starter-persona-${persona.id}`}
                            src={animationUrl}
                          />
                        ) : (
                          <ProfileAvatar
                            avatarUrl={persona.avatarUrl}
                            className="h-24 w-24 text-3xl"
                            label={persona.displayName}
                          />
                        )}
                        <span className="font-mono text-2xs font-medium uppercase tracking-[0.15em]">
                          {persona.displayName}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {transaction.error ? (
                <p className="onb-note onb-note-warn">
                  {transaction.error}
                  {starterChannelFailureCount === 1 ? " Try again." : null}
                </p>
              ) : null}
            </div>
            <div className="onb-actions">
              <Button
                data-testid="community-team-intro-enter"
                disabled={isPending || transaction.stage === "entering"}
                onClick={() =>
                  void (starterChannelFailureCount >= 2 ? finish() : finalize())
                }
                size="lg"
              >
                {isPending || transaction.stage === "entering" ? (
                  <LoadingDots label="Preparing Welcome" />
                ) : starterChannelFailureCount >= 2 ? (
                  "Skip for now"
                ) : (
                  "Take me to Colony"
                )}
              </Button>
              <button
                className="onb-quiet-action"
                data-testid="community-team-intro-back"
                disabled={isPending || transaction.stage === "entering"}
                onClick={backToProfile}
                type="button"
              >
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </MachineCanvas>
  );
}
