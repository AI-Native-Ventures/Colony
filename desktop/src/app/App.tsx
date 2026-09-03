import { emit, isTauri } from "@/shared/api/nativeBridge";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { router } from "@/app/router";
import {
  completeCommunityViewTransition,
  replaceCommunityDestinationRoute,
} from "@/app/communityViewTransition";
import { deriveShellRoute } from "@/app/AppShell.helpers";
import { ThemeGrainientBackground } from "@/app/ThemeGrainientBackground";
import { CommunityThemeController } from "@/shared/theme/CommunityThemeController";
import { useReloadShortcut } from "@/app/useReloadShortcut";
import { KnownAgentPubkeysProvider } from "@/features/agents/useKnownAgentPubkeys";
import { huddleWindowChannelId } from "@/features/huddle/lib/huddleWindow";
import { useAppOnboardingState } from "@/features/onboarding/hooks";
import { useMachineOnboardingState } from "@/features/onboarding/machineOnboarding";
import { isFreshFounder } from "@/features/onboarding/freshFounder";
import { isNewOnboardingEnabled } from "@/features/onboarding/newOnboardingFlag";
import { CanvasFirstRunHost } from "@/features/onboarding/ui/new/CanvasFirstRunHost";
import { ExistingIdentityProfileFlow } from "@/features/onboarding/ui/new/ExistingIdentityProfileFlow";
import {
  type FirstCommunityPage,
  useCommunityOnboarding,
  markCommunityOnboardingComplete,
  resolveProfileCheckAction,
  isTransactionStillConnecting,
  shouldForceFirstCommunityJourney,
} from "@/features/onboarding/communityOnboarding";
import { CommunityOnboardingFlow } from "@/features/onboarding/ui/CommunityOnboardingFlow";
import {
  MachineOnboardingFlow,
  type MachineOnboardingPage,
} from "@/features/onboarding/ui/MachineOnboardingFlow";
import { PendingInviteGate } from "@/features/onboarding/ui/PendingInviteGate";
import { KeyringLockedScreen } from "@/features/onboarding/ui/KeyringLockedScreen";
import { RelaunchRequiredScreen } from "@/features/onboarding/ui/RelaunchRequiredScreen";
import { ResetFailedScreen } from "@/features/onboarding/ui/ResetFailedScreen";
import { loadCommunityDiscoveryAfterLeave } from "@/features/communities/communityStorage";
import { useCommunityInit } from "@/features/communities/useCommunityInit";
import { useNestNotifications } from "@/features/communities/useNestNotifications";
import { useCommunities } from "@/features/communities/useCommunities";
import {
  loadCommunityDestination,
  markPendingCommunityRestore,
  saveCommunityDestination,
} from "@/features/communities/communityNavigationStorage";
import {
  onAddCommunityPrefillAvailable,
  requestAddCommunityPrefill,
} from "@/features/communities/addCommunityPrefill";
import { WorkspaceSetupFlow } from "@/features/onboarding/ui/new/WorkspaceSetupFlow";
import { CommunityApplyErrorScreen } from "@/features/communities/ui/CommunityApplyErrorScreen";
import { CommunityChangeOverlay } from "@/features/communities/ui/CommunityChangeOverlay";
import { setAvatarProfileSyncQueryClient } from "@/features/profile/avatarProfileSync";
import { EncryptedBackupProvider } from "@/features/settings/EncryptedBackupProvider";
import { createBuzzQueryClient } from "@/shared/api/queryClient";
import { isSharedIdentity as isSharedIdentityCmd } from "@/shared/api/tauri";
import { getProfile } from "@/shared/api/tauriProfiles";
import {
  type AddCommunityDeepLinkPayload,
  listenForDeepLinks,
} from "@/shared/deep-link";
import { cn } from "@/shared/lib/cn";
import { AntMark } from "@/shared/ui/colony-logo/AntMark";
import { WalkingAnt } from "@/shared/ui/colony-logo/WalkingAnt";
import { FuzzyMark } from "@/shared/ui/colony-logo/FuzzyMark";
import { StartupWindowDragRegion } from "@/shared/ui/StartupWindowDragRegion";

const LOADING_TEXT = "Setting up your community...";

// Minimum time the cold-boot splash stays on screen. A real boot resolves the
// community in well under 100ms, and the native window setup plus first paint
// can take longer than that — without a hold, the ant is unmounted before it is
// ever visible. The hold runs as an overlay above the already-mounted app, so
// time-to-interactive is unchanged; only the reveal waits.
const BOOT_SPLASH_MIN_VISIBLE_MS = 1_200;
const BOOT_SPLASH_FADE_MS = 200;
const INITIAL_RENDER_READY_EVENT = "initial-render-ready";

type BootSplashPhase = "holding" | "fading" | "done";

function useInitialRenderReady() {
  useLayoutEffect(() => {
    if (!isTauri()) {
      return;
    }

    void emit(INITIAL_RENDER_READY_EVENT);
  }, []);
}

// E2E runs skip the hold (it would slow every spec's boot and block pointer
// actionability); a spec can opt back in via __BUZZ_E2E__.bootSplashHoldMs.
function bootSplashHoldMs(): number {
  const e2e = (
    window as Window & {
      __BUZZ_E2E__?: { bootSplashHoldMs?: number };
    }
  ).__BUZZ_E2E__;
  if (e2e) {
    return e2e.bootSplashHoldMs ?? 0;
  }
  return BOOT_SPLASH_MIN_VISIBLE_MS;
}

function useBootSplashHold(): BootSplashPhase {
  const [phase, setPhase] = useState<BootSplashPhase>(() =>
    bootSplashHoldMs() > 0 ? "holding" : "done",
  );

  useEffect(() => {
    const holdMs = bootSplashHoldMs();
    if (holdMs <= 0) {
      return;
    }
    const fadeTimer = window.setTimeout(() => setPhase("fading"), holdMs);
    const doneTimer = window.setTimeout(
      () => setPhase("done"),
      holdMs + BOOT_SPLASH_FADE_MS,
    );
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(doneTimer);
    };
  }, []);

  return phase;
}

// Animated Colony mark for the loading gates. The static AntMark renders in
// normal flow and sizes the box — it's plain SVG (no JS/SMIL), so it paints on
// the very first frame even before scripting starts, avoiding a blank flash on
// hard reload. The animated FuzzyMark is layered on top and takes over once it
// begins playing.
function AntLoader({
  ariaLabel,
  className,
  tintClassName = "text-foreground",
}: {
  ariaLabel: string;
  className?: string;
  tintClassName?: string;
}) {
  return (
    <div className={cn("relative", tintClassName, className)}>
      <AntMark className="block h-auto w-full" />
      <FuzzyMark
        ariaLabel={ariaLabel}
        className="absolute inset-0 h-full! w-full! [&>svg]:h-full [&>svg]:w-full [&>svg]:max-w-full"
        fuzz
        loop
        loopRestSeconds={0}
      />
    </div>
  );
}

// Cold boot gate: the theme-adaptive grainient background with a single
// centered Colony ant, legs walking, over it — the same static mark as
// before, now with its legs mid-stride (ported from the WalkingAnt gait).
// Replaces the old "Setting up your community" text, which stays as an
// sr-only caption.
function AppLoadingGate() {
  return (
    <div
      className="buzz-setup-loading-shell flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-10"
      data-testid="app-loading-gate"
      role="status"
    >
      <StartupWindowDragRegion />
      <ThemeGrainientBackground />
      <span className="sr-only">{LOADING_TEXT}</span>
      <WalkingAnt className="relative z-10 h-auto w-28" />
    </div>
  );
}

// Quiet gate for switching between already-set-up communities: visually empty
// unless the switch takes long, so fast switches don't flash the boot splash.
function CommunitySwitchGate() {
  const [showSpinner, setShowSpinner] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setShowSpinner(true), 300);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className="flex min-h-dvh items-center justify-center bg-background"
      data-testid="community-switch-gate"
      role="status"
    >
      <StartupWindowDragRegion />
      <span className="sr-only">Switching community…</span>
      {showSpinner ? (
        <AntLoader
          ariaLabel="Switching community…"
          className="h-auto w-20"
          tintClassName="text-muted-foreground"
        />
      ) : null}
    </div>
  );
}

function CommunityQueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(createBuzzQueryClient);

  useEffect(() => setAvatarProfileSyncQueryClient(queryClient), [queryClient]);

  useEffect(() => {
    const e2eWindow = window as Window & {
      __BUZZ_E2E__?: unknown;
      __BUZZ_E2E_QUERY_CLIENT__?: typeof queryClient;
    };
    if (!e2eWindow.__BUZZ_E2E__) {
      return;
    }

    e2eWindow.__BUZZ_E2E_QUERY_CLIENT__ = queryClient;
    return () => {
      if (e2eWindow.__BUZZ_E2E_QUERY_CLIENT__ === queryClient) {
        delete e2eWindow.__BUZZ_E2E_QUERY_CLIENT__;
      }
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function AppReady({
  isSharedIdentity,
  isCommunitySwitch,
}: {
  isSharedIdentity: boolean;
  isCommunitySwitch: boolean;
}) {
  const onboarding = useAppOnboardingState(isSharedIdentity);

  if (onboarding.stage === "reset-failed") {
    return <ResetFailedScreen />;
  }

  if (onboarding.stage === "keyring-locked") {
    return <KeyringLockedScreen />;
  }

  if (onboarding.stage === "relaunch-required") {
    return <RelaunchRequiredScreen />;
  }

  if (onboarding.stage === "onboarding") {
    // Everything that reaches this gate is an identity that already exists
    // on this machine and has no relay profile yet: "bring your own key", a
    // reinstall, a second machine, or the dev-only forced-fresh replay
    // (VITE_BUZZ_FORCE_FRESH_ONBOARDING). A brand-new founder never arrives
    // here -- CanvasFirstRunHost in CommunityApp owns that walk, gated by
    // isFreshFounder, because claiming the workspace is one of its steps.
    //
    // Identity-lost recovery does not arrive here either: a lost keyring
    // pins machine onboarding to its own stage, so the canvas key-import
    // screen answers it before CommunityApp is ever mounted.
    //
    // The only open question left, then, is what to call them.
    return (
      <ExistingIdentityProfileFlow
        initialProfile={onboarding.flow.initialProfile.profile}
        key={onboarding.currentPubkey ?? "anonymous"}
        onComplete={onboarding.flow.actions.complete}
        onSkip={onboarding.flow.actions.skipForNow}
      />
    );
  }

  if (onboarding.stage === "blocking") {
    return isCommunitySwitch ? <CommunitySwitchGate /> : <AppLoadingGate />;
  }

  return (
    <EncryptedBackupProvider
      onOpenSettings={() =>
        void router.navigate({
          to: "/settings",
          search: { section: "profile" },
        })
      }
    >
      <KnownAgentPubkeysProvider>
        <RouterProvider router={router} />
      </KnownAgentPubkeysProvider>
    </EncryptedBackupProvider>
  );
}

function CommunityApp({
  currentPubkey,
  onBackToMachineConfig,
  onRequestSignIn,
  sharedIdentity,
}: {
  currentPubkey: string | null;
  onBackToMachineConfig: () => void;
  /**
   * Explicit user exit from the canvas first run toward email sign-in, wired
   * only while that run is on screen (the canvas host is the sole caller).
   */
  onRequestSignIn: () => void;
  sharedIdentity: boolean;
}) {
  const {
    activeCommunity,
    communities,
    reinitKey,
    addCommunity,
    clearCommunities,
    removeCommunity,
    switchCommunity,
    reconnectCommunity,
  } = useCommunities();
  const communityOnboarding = useCommunityOnboarding();
  const connectingTransactionRef = useRef<string | null>(null);
  // Tracks the ID of the profile-check request that has been launched for the
  // current connecting transaction. Prevents the effect from launching a
  // second request if it re-runs while a fetch is in flight.
  const profileCheckTransactionRef = useRef<string | null>(null);
  // Always reflects the live transaction object so async callbacks can perform
  // an atomic check of both ID and stage before mutating state.
  const transactionRef = useRef(communityOnboarding.transaction);
  transactionRef.current = communityOnboarding.transaction;
  const [isCommunityChangeOpen, setIsCommunityChangeOpen] = useState(false);
  const [resumeFirstCommunityPage, setResumeFirstCommunityPage] =
    useState<FirstCommunityPage | null>(null);
  const isFindingCommunityAfterLeave =
    activeCommunity === null && loadCommunityDiscoveryAfterLeave();

  // Surface nest-related backend events (repos-dir errors, legacy migration)
  // as toasts. Mounted before useCommunityInit so the listeners are registered
  // ahead of the first apply_workspace call.
  useNestNotifications();

  // Composite key: changes when community ID changes OR when
  // the active community's config is updated (relayUrl/token).
  const communityKey = `${activeCommunity?.id ?? "none"}-${reinitKey}`;

  // Latch once the community key deviates from its cold-boot value: from then
  // on, loading phases are in-app switches and get the quiet gate instead of
  // the full "Setting up your community" splash.
  const initialCommunityKeyRef = useRef(communityKey);
  const hasSwitchedCommunityRef = useRef(false);
  if (communityKey !== initialCommunityKeyRef.current) {
    hasSwitchedCommunityRef.current = true;
  }
  const isCommunitySwitch = hasSwitchedCommunityRef.current;

  const community = useCommunityInit(
    activeCommunity,
    communityKey,
    sharedIdentity,
    isFindingCommunityAfterLeave,
  );

  const transitionCommunity = useCallback(
    async (targetCommunityId: string) => {
      const activeCommunityId = activeCommunity?.id;
      if (targetCommunityId === activeCommunityId) return;
      if (activeCommunityId) {
        const route = deriveShellRoute(router.state.location.pathname);
        saveCommunityDestination(
          activeCommunityId,
          route.selectedView === "channel" && route.selectedChannelId
            ? { kind: "channel", channelId: route.selectedChannelId }
            : { kind: "home" },
        );
        await router.navigate({ to: "/", replace: true });
        markPendingCommunityRestore(targetCommunityId);
        const destination = loadCommunityDestination(targetCommunityId);
        if (destination?.kind === "channel") {
          replaceCommunityDestinationRoute(
            destination.channelId,
            router.history,
          );
        }
      }
      switchCommunity(targetCommunityId);
    },
    [activeCommunity?.id, switchCommunity],
  );

  const handleCommunityOnboardingConnect = useCallback(async () => {
    const transaction = communityOnboarding.transaction;
    if (transaction?.stage !== "connecting") return;
    if (connectingTransactionRef.current === transaction.id) return;
    connectingTransactionRef.current = transaction.id;
    if (transaction.communityId) {
      await transitionCommunity(transaction.communityId);
      return;
    }
    const previousCommunityId = activeCommunity?.id;
    const relayAlreadyExists = communities.some(
      (community) => community.relayUrl === transaction.relayUrl,
    );
    const id = addCommunity({
      id: crypto.randomUUID(),
      name: transaction.communityName,
      relayUrl: transaction.relayUrl,
      token: transaction.token,
      reposDir: transaction.reposDir,
      pubkey: currentPubkey ?? undefined,
      addedAt: new Date().toISOString(),
    });
    communityOnboarding.update({
      communityId: id,
      previousCommunityId,
      addedCommunity: !relayAlreadyExists,
      error: undefined,
    });
    await transitionCommunity(id);
    reconnectCommunity();
  }, [
    activeCommunity?.id,
    addCommunity,
    communities,
    communityOnboarding,
    currentPubkey,
    reconnectCommunity,
    transitionCommunity,
  ]);

  const handleCommunityOnboardingCancel = useCallback(async () => {
    const transaction = communityOnboarding.transaction;
    communityOnboarding.clear();

    if (!transaction?.communityId) return;
    if (!transaction.addedCommunity) {
      if (transaction.previousCommunityId) {
        await transitionCommunity(transaction.previousCommunityId);
      }
      return;
    }
    if (communities.length === 1) {
      if (transaction.source === "first-community") {
        setResumeFirstCommunityPage(transaction.firstCommunityPage ?? "join");
      }
      clearCommunities();
      return;
    }
    if (transaction.previousCommunityId) {
      await transitionCommunity(transaction.previousCommunityId);
    }
    removeCommunity(transaction.communityId);
  }, [
    clearCommunities,
    communities.length,
    communityOnboarding,
    removeCommunity,
    transitionCommunity,
  ]);

  const bootSplashPhase = useBootSplashHold();

  const transaction = communityOnboarding.transaction;
  useEffect(() => {
    if (transaction?.stage !== "connecting") {
      connectingTransactionRef.current = null;
      profileCheckTransactionRef.current = null;
    }
  }, [transaction?.stage]);
  const targetIsReady =
    transaction?.communityId === activeCommunity?.id &&
    community.isReady &&
    community.appliedKey === communityKey;
  const forceFirstCommunityJourney = transaction
    ? shouldForceFirstCommunityJourney(transaction)
    : false;
  useEffect(() => {
    if (transaction?.stage !== "connecting" || !targetIsReady) return;
    const transactionId = transaction.id;
    const relayUrl = transaction.relayUrl;
    if (profileCheckTransactionRef.current === transactionId) return;
    profileCheckTransactionRef.current = transactionId;

    if (forceFirstCommunityJourney) {
      communityOnboarding.update(
        { stage: "profile", error: undefined },
        transactionId,
      );
      return;
    }

    // resolveProfileCheckAction resolves exactly once (Promise.race + timer
    // cleared on settle), so no settled flag is needed here.
    void resolveProfileCheckAction(getProfile, 10_000).then((result) => {
      // Atomic staleness guard via isTransactionStillConnecting: the
      // transaction must still be the same one that launched this request
      // AND still be in connecting. Covers cancel+replacement (B's ID !== A's)
      // and cancel-without-replacement (transactionRef.current is null).
      if (!isTransactionStillConnecting(transactionRef.current, transactionId))
        return;

      if (result.action === "skip") {
        markCommunityOnboardingComplete(result.profile.pubkey, relayUrl);
        communityOnboarding.clear();
      } else {
        communityOnboarding.update(
          { stage: "profile", error: undefined },
          transactionId,
        );
      }
    });
  }, [
    communityOnboarding,
    forceFirstCommunityJourney,
    targetIsReady,
    transaction?.stage,
    transaction?.id,
    transaction?.relayUrl,
  ]);
  // During "entering" the transaction stays alive as a curtain: the app mounts
  // underneath (already pointed at the Welcome channel route) while the
  // onboarding screen covers it, then fades once Welcome reports ready.
  //
  // The flow must keep ONE stable position in the element tree across every
  // stage. Rendering it from a different slot when the stage flips to
  // "entering" would remount it — React state resets and the "Meet your
  // starter team" screen visibly restarts mid-handoff.
  const isEnteringCurtain = transaction?.stage === "entering";

  // The app mounts (and starts loading data) beneath the splash overlay; the
  // overlay just keeps the bee on screen long enough to be seen, then fades.
  // Community switches keep their quiet gate.
  const showBootSplashOverlay =
    bootSplashPhase !== "done" && !isCommunitySwitch;

  // Wait for this exact community config to be applied to the backend before
  // rendering anything that connects to the relay. The appliedKey check avoids
  // a one-render race where React sees the new active community while the
  // Tauri backend is still configured for the previous one.
  const communityApplied =
    community.isReady && community.appliedKey === communityKey;
  useLayoutEffect(() => {
    if (communityApplied) {
      completeCommunityViewTransition();
    }
  }, [communityApplied]);

  // The canvas first run owns the founder journey from before any community
  // exists: claiming the workspace is one of its own steps. Latching it
  // "active" is what keeps it mounted once provisioning succeeds and the
  // community stops looking like a first run.
  const [canvasRunState, setCanvasRunState] = useState<
    "unstarted" | "active" | "finished"
  >("unstarted");
  const canvasEligible =
    isNewOnboardingEnabled(import.meta.env) &&
    !transaction &&
    canvasRunState !== "finished" &&
    (canvasRunState === "active" ||
      isFreshFounder({
        pubkey: currentPubkey,
        // Scoped to this identity: a community stamped with a DIFFERENT
        // pubkey (an earlier account on this machine) must not disqualify a
        // genuinely new signup from the canvas flow. `community.pubkey` is
        // display-only, but it is the only local signal of "which identity
        // already has a workspace here" — see Community.pubkey's doc.
        hasOwnCommunity: communities.some(
          (community) => community.pubkey === currentPubkey,
        ),
      }));
  useEffect(() => {
    if (canvasEligible && canvasRunState === "unstarted") {
      setCanvasRunState("active");
    }
  }, [canvasEligible, canvasRunState]);

  let appContent: ReactNode = null;
  if (canvasEligible && currentPubkey) {
    appContent = (
      <CanvasFirstRunHost
        activeRelayUrl={activeCommunity?.relayUrl ?? null}
        communityApplied={communityApplied}
        currentPubkey={currentPubkey}
        onFinished={() => setCanvasRunState("finished")}
        onRequestSignIn={onRequestSignIn}
      />
    );
  } else if (!transaction) {
    if (community.needsSetup) {
      // No community on this machine yet: join one, create one, or reconnect
      // one this identity already owns.
      appContent = (
        <WorkspaceSetupFlow
          initialPage={resumeFirstCommunityPage ?? undefined}
          onBack={
            isFindingCommunityAfterLeave ? undefined : onBackToMachineConfig
          }
        />
      );
    } else if ("error" in community && community.error) {
      // Surface apply failures so the user can retry or change community.
      appContent = (
        <>
          <CommunityApplyErrorScreen
            error={community.error}
            onChangeCommunity={() => setIsCommunityChangeOpen(true)}
            onRetry={reconnectCommunity}
          />
          {isCommunityChangeOpen ? (
            <CommunityChangeOverlay
              onClose={() => setIsCommunityChangeOpen(false)}
            />
          ) : null}
        </>
      );
    }
  }
  if (appContent === null && (!transaction || isEnteringCurtain)) {
    appContent = communityApplied ? (
      <CommunityQueryProvider key={communityKey}>
        <CommunityThemeController />
        <AppReady
          isCommunitySwitch={isCommunitySwitch}
          key={communityKey}
          isSharedIdentity={sharedIdentity}
        />
        {showBootSplashOverlay ? (
          <div
            aria-hidden="true"
            className={cn(
              "fixed inset-0 z-50 transition-opacity",
              bootSplashPhase === "fading" ? "opacity-0" : "opacity-100",
            )}
            data-testid="boot-splash-overlay"
            style={{ transitionDuration: `${BOOT_SPLASH_FADE_MS}ms` }}
          >
            <AppLoadingGate />
          </div>
        ) : null}
      </CommunityQueryProvider>
    ) : isCommunitySwitch ? (
      <CommunitySwitchGate />
    ) : (
      <AppLoadingGate />
    );
  }

  return (
    <>
      <span
        aria-hidden="true"
        data-community-id={activeCommunity?.id ?? ""}
        data-community-key={communityKey}
        data-community-relay={activeCommunity?.relayUrl ?? ""}
        data-community-state={
          "appliedKey" in community && community.appliedKey === communityKey
            ? community.isReady
              ? "ready"
              : "applying"
            : "pending"
        }
        data-testid="community-lifecycle-marker"
      />
      {appContent}
      {transaction ? (
        <div
          className={isEnteringCurtain ? "fixed inset-0 z-50" : undefined}
          data-testid={
            isEnteringCurtain ? "onboarding-entering-curtain" : undefined
          }
        >
          <CommunityOnboardingFlow
            onCancel={handleCommunityOnboardingCancel}
            onConnect={handleCommunityOnboardingConnect}
          />
        </div>
      ) : null}
    </>
  );
}

function MachineBootstrap({ sharedIdentity }: { sharedIdentity: boolean }) {
  const { activeCommunity } = useCommunities();
  const communityOnboarding = useCommunityOnboarding();
  const machine = useMachineOnboardingState({
    activeCommunityPubkey: activeCommunity
      ? (activeCommunity.pubkey ?? null)
      : undefined,
    isSharedIdentity: sharedIdentity,
  });
  const [machineInitialPage, setMachineInitialPage] =
    useState<MachineOnboardingPage>();

  // Back out of community selection into the machine flow. It used to reopen
  // on the agent-config screen, which no longer exists: the brain question it
  // asked is the canvas flow's to ask. The landing screen is what "back" means
  // now, and it is the only page with somewhere further back to go.
  const reopenMachineStart = useCallback(() => {
    setMachineInitialPage("identity");
    machine.reopen();
  }, [machine.reopen]);

  // The canvas signup path hands a user who already has an account over to
  // the email sign-in detour. Their explicit click is what leaves the canvas
  // run behind; nothing here finishes or discards it silently.
  const openMachineSignin = useCallback(() => {
    setMachineInitialPage("account-signin");
    machine.reopen();
  }, [machine.reopen]);

  const completeMachineOnboarding = useCallback(
    (pubkey?: string) => {
      setMachineInitialPage(undefined);
      machine.complete(pubkey);
    },
    [machine.complete],
  );

  const openAddCommunity = useCallback(
    (payload: AddCommunityDeepLinkPayload & { requestId: string }) =>
      activeCommunity
        ? requestAddCommunityPrefill(payload)
        : communityOnboarding.start({
            source: "add-community",
            relayUrl: payload.relayUrl,
            communityName: payload.name,
          }),
    [activeCommunity, communityOnboarding.start],
  );

  // Community links are app-global work. A Huddle companion loads the same
  // React tree, but must never race the main window for the native pending-link
  // queue or replace its dedicated transcript surface with onboarding.
  const acceptsCommunityDeepLinks = huddleWindowChannelId() === null;
  useEffect(() => {
    if (!acceptsCommunityDeepLinks) return;

    const unlisten = listenForDeepLinks({
      startCommunityOnboarding: communityOnboarding.start,
      openAddCommunity,
      onAddCommunityAvailable: onAddCommunityPrefillAvailable,
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [acceptsCommunityDeepLinks, communityOnboarding.start, openAddCommunity]);

  if (machine.stage === "reset-failed") return <ResetFailedScreen />;
  if (machine.stage === "keyring-locked") return <KeyringLockedScreen />;
  if (machine.stage === "relaunch-required") return <RelaunchRequiredScreen />;
  if (machine.stage === "blocking") return <AppLoadingGate />;
  if (machine.stage === "ready") {
    return (
      <CommunityApp
        currentPubkey={machine.currentPubkey}
        onBackToMachineConfig={reopenMachineStart}
        onRequestSignIn={openMachineSignin}
        sharedIdentity={sharedIdentity}
      />
    );
  }

  // A community deep link that arrived before machine onboarding finished is
  // persisted immediately and acknowledged here. Invite claiming waits until
  // setup completes so it is signed only by the user's final identity.
  const transaction = communityOnboarding.transaction;
  const isDeepLink =
    transaction?.source === "deep-link-join" ||
    transaction?.source === "deep-link-connect";
  const shouldAcknowledgeDeepLink = isDeepLink && !transaction.acknowledged;

  return (
    <>
      <MachineOnboardingFlow
        complete={completeMachineOnboarding}
        continueWithIdentity={machine.continueWithIdentity}
        continueWithRecoveredIdentity={machine.continueWithRecoveredIdentity}
        identityLost={machine.identityLost}
        initialPage={machineInitialPage}
        queryClient={machine.queryClient}
      />
      {shouldAcknowledgeDeepLink ? <PendingInviteGate /> : null}
    </>
  );
}

export function App() {
  useReloadShortcut();
  useInitialRenderReady();
  const [sharedIdentity, setSharedIdentity] = useState<boolean | null>(null);
  const [queryClient] = useState(createBuzzQueryClient);

  useEffect(() => {
    isSharedIdentityCmd()
      .then(setSharedIdentity)
      .catch((err) => {
        console.warn("is_shared_identity command failed:", err);
        setSharedIdentity(false);
      });
  }, []);

  if (sharedIdentity === null) return <AppLoadingGate />;

  return (
    <QueryClientProvider client={queryClient}>
      <MachineBootstrap sharedIdentity={sharedIdentity} />
    </QueryClientProvider>
  );
}
