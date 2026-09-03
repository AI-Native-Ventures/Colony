// desktop/src/features/onboarding/ui/new/CanvasFirstRunHost.tsx
import { useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  checkColonyCommunityName,
  createColonyCommunity,
  listColonyCommunities,
} from "@/features/communities/hostedCommunityApi";
import { useCommunities } from "@/features/communities/useCommunities";

import { createFakeServices } from "../../contracts.fake";
import { completeFirstRun } from "../../flow/completeFirstRun";
import { DEFAULT_COMPLETE_FIRST_RUN_IO } from "../../flow/completeFirstRunIo";
import { draftFromAnswers } from "../../flow/founderBrief";
import {
  provisionWorkspace,
  type ProvisionOutcome,
} from "../../flow/provisionWorkspace";
import type { OnboardingAnswers } from "../../flow/steps";
import { NewOnboardingFlow } from "./NewOnboardingFlow";

/**
 * How long the finish step waits for the community config to reach the Tauri
 * backend. The apply runs while the user answers the remaining screens, so
 * this is a backstop for a stalled apply, not the expected wait.
 */
const APPLY_DEADLINE_MS = 20_000;
const APPLY_POLL_MS = 250;

type Props = {
  currentPubkey: string;
  /** Live from CommunityApp: this community's config is applied. */
  communityApplied: boolean;
  /** Relay of the applied community, when one exists. */
  activeRelayUrl: string | null;
  onFinished: () => void;
  /**
   * Explicit user exit toward email sign-in; CommunityApp routes it to the
   * machine flow's account-signin page. The canvas run is left unstarted.
   */
  onRequestSignIn?: () => void;
  /**
   * This run was asked for by an identity that already exists (the "Create a
   * community" door), rather than started by a brand-new signup.
   */
  existingIdentity?: boolean;
  /** Leaves such a run from its first screen, back to the choice screen. */
  onLeaveRun?: () => void;
};

/**
 * Owns the canvas first run from above the community boundary.
 *
 * The flow itself must run before any community exists, because claiming the
 * workspace is one of its steps. That puts it outside `AppReady`, so the two
 * things `AppReady` would have supplied arrive here instead: provisioning on
 * the company screen, and completion once the config has applied underneath.
 */
export function CanvasFirstRunHost({
  currentPubkey,
  communityApplied,
  activeRelayUrl,
  onFinished,
  onRequestSignIn,
  existingIdentity = false,
  onLeaveRun,
}: Props) {
  const queryClient = useQueryClient();
  const { addCommunity } = useCommunities();
  // Payments, scrape and invites stay fakes here exactly as they were inside
  // AppReady; NewOnboardingFlow swaps in the wired services itself outside
  // the e2e build.
  const services = useMemo(() => createFakeServices(), []);

  // Snapshot live values for callbacks without re-identifying the flow: a new
  // services or callback identity mid-run restarts in-flight steps.
  const appliedRef = useRef(communityApplied);
  appliedRef.current = communityApplied;
  const relayUrlRef = useRef(activeRelayUrl);
  relayUrlRef.current = activeRelayUrl;

  // Internal auto-connect builds already have a community when the flow
  // mounts. Read once: the value flips as soon as provisioning succeeds, and
  // re-reading it would turn the claim step off mid-run.
  const hadCommunityAtMount = useRef(activeRelayUrl !== null).current;

  const provision = useCallback(
    (companyName: string, storedSlug: string | null) =>
      provisionWorkspace(companyName, storedSlug, {
        check: checkColonyCommunityName,
        create: createColonyCommunity,
        listMine: listColonyCommunities,
      }),
    [],
  );

  const onProvisioned = useCallback(
    (outcome: Extract<ProvisionOutcome, { ok: true }>, companyName: string) => {
      // The typed company name is the label; the claimed address never
      // surfaces in the interface.
      addCommunity({
        id: outcome.communityId ?? crypto.randomUUID(),
        name: companyName,
        relayUrl: outcome.relayUrl,
        pubkey: currentPubkey,
        addedAt: new Date().toISOString(),
      });
    },
    [addCommunity, currentPubkey],
  );

  const provisioning = useMemo(
    () => (hadCommunityAtMount ? null : { provision, onProvisioned }),
    [hadCommunityAtMount, provision, onProvisioned],
  );

  const waitForApply = useCallback(async () => {
    const startedAt = Date.now();
    while (!appliedRef.current || relayUrlRef.current === null) {
      if (Date.now() - startedAt > APPLY_DEADLINE_MS) {
        throw new Error(
          "Your workspace is taking longer than expected to open. Try again.",
        );
      }
      await new Promise((resolve) => setTimeout(resolve, APPLY_POLL_MS));
    }
    return relayUrlRef.current;
  }, []);

  const onComplete = useCallback(
    async (answers: OnboardingAnswers) => {
      const relayUrl = await waitForApply();
      await completeFirstRun(
        {
          queryClient,
          relayUrl,
          pubkey: currentPubkey,
          // Built here rather than stashed on a transaction: this path never
          // creates one, and the brief used to vanish because of it.
          draft: draftFromAnswers(answers),
          profileDisplayName: answers.founder?.fullName ?? null,
          profileAvatarUrl: answers.founder?.avatarUrl ?? null,
        },
        DEFAULT_COMPLETE_FIRST_RUN_IO,
      );
      onFinished();
    },
    [currentPubkey, onFinished, queryClient, waitForApply],
  );

  return (
    <NewOnboardingFlow
      key={currentPubkey}
      services={services}
      provisioning={provisioning}
      onComplete={onComplete}
      onRequestSignIn={onRequestSignIn}
      existingIdentity={existingIdentity}
      onLeaveRun={onLeaveRun}
    />
  );
}
