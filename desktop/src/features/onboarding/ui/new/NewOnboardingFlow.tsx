// desktop/src/features/onboarding/ui/new/NewOnboardingFlow.tsx
import { useCallback, useEffect, useRef, useState } from "react";

import { useGlobalAgentConfig } from "@/features/agents/useGlobalAgentConfig";
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from "@/shared/lib/safeStorage";
import type { AuthFailure } from "../../authService";
import { applyBrainChoice } from "../../applyBrainChoice";
import { COLONY_AGENT_RUNTIME_ID } from "../../automaticRuntime";
import { applyFreshSignupDefaults } from "../../freshSignupDefaults";
import { createWiredAuthService } from "../../lib/wiredAuthService";
import { createWiredScrapeService } from "../../lib/wiredScrapeService";
import { createWiredPaymentsService } from "../../lib/wiredPaymentsService";
import type { OnboardingServices, ScrapeResult } from "../../contracts";
import type { ProvisionOutcome } from "../../flow/provisionWorkspace";
import {
  clearAnswers,
  loadAnswers,
  saveAnswers,
  type AnswerStorage,
} from "../../flow/persistence";
import {
  backStep,
  nextStep,
  resumeStep,
  stepPosition,
  type OnboardingAnswers,
  type OnboardingStep,
} from "../../flow/steps";
import type { TrackResult } from "../../flow/track";
import { invitesEnabled } from "../../newOnboardingFlag";
import { OnboardingCanvas } from "./OnboardingCanvas";
import {
  AccountScreen,
  accountReady,
  type AccountValues,
} from "./screens/AccountScreen";
import { BrainScreen } from "./screens/BrainScreen";
import {
  BusinessScreen,
  type BusinessPatch,
  type BusinessStage,
} from "./screens/BusinessScreen";
import { CompanyScreen, type CompanyValues } from "./screens/CompanyScreen";
import { CreditsScreen } from "./screens/CreditsScreen";
import { DescriptionScreen } from "./screens/DescriptionScreen";
import { InviteScreen } from "./screens/InviteScreen";
import { ProbingScreen } from "./screens/ProbingScreen";
import { ReadingScreen } from "./screens/ReadingScreen";
import { RecoveryScreen } from "./screens/RecoveryScreen";

/**
 * Answers persist through the throw-safe storage accessors, so a denied-storage
 * origin degrades to an unpersisted flow instead of crashing first run.
 */
const answerStorage: AnswerStorage = {
  get: (key) => getStorageItem(key),
  set: (key, value) => void setStorageItem(key, value),
  remove: (key) => void removeStorageItem(key),
};

/** Read once per flow mount: CSS cannot reach a JS interval, so every screen
 *  with a timer receives this as a prop instead of consulting media queries. */
function readReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const E2E_AUTH_FAILURE_KEY = "colony.e2e.authFailure";

/**
 * E2E only: one spec pins an auth failure so the account screen's failure
 * states stay testable without pointing the flow at a live server. The mode
 * check keeps this unreachable outside the e2e build, exactly like the flag's
 * own localStorage override in newOnboardingFlag.ts.
 */
function readE2eAuthFailure(
  env: Record<string, string | undefined>,
): AuthFailure | null {
  if (env.MODE !== "e2e") return null;
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(E2E_AUTH_FAILURE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { kind?: unknown }).kind === "string"
    ) {
      return parsed as AuthFailure;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Which auth service the flow runs on. The boundary newOnboardingFlag draws
 * for the redesigned flow itself decides this too: the build-time switch
 * turns the real service on, and the e2e build mode keeps fakes so existing
 * specs stay hermetic.
 */
export function resolveAuthServices(
  env: Record<string, string | undefined>,
  passed: OnboardingServices,
): OnboardingServices {
  // Anything that is not the e2e build gets the real services.
  //
  // This used to also require VITE_NEW_ONBOARDING === "1", from when the flow
  // was opt-in. Making the flow the default silently stopped that flag being
  // set, so the condition stopped matching and a production build quietly fell
  // back to `contracts.fake.ts`: an account that was never created, and a
  // hand-written paragraph about a Johannesburg workshop presented as what
  // Colony found on the user's own website. Nothing failed, which is what made
  // it dangerous. The e2e mode is the only build that keeps fakes, so its
  // specs stay hermetic.
  const useReal = env.MODE !== "e2e";
  const base = useReal
    ? {
        ...passed,
        auth: createWiredAuthService(),
        scrape: createWiredScrapeService(),
        payments: createWiredPaymentsService(),
      }
    : passed;
  const forced = readE2eAuthFailure(env);
  if (forced === null) return base;
  return {
    ...base,
    auth: {
      ...base.auth,
      signUp: async () => {
        throw forced;
      },
    },
  };
}

export type OnboardingProvisioning = {
  provision: (
    companyName: string,
    storedSlug: string | null,
  ) => Promise<ProvisionOutcome>;
  onProvisioned: (
    outcome: Extract<ProvisionOutcome, { ok: true }>,
    companyName: string,
  ) => void;
};

type Props = {
  services: OnboardingServices;
  /**
   * How the company screen claims a workspace. Null when a community is
   * already applied (internal auto-connect builds): the screen then records
   * the name and provisions nothing.
   */
  provisioning: OnboardingProvisioning | null;
  /**
   * Completes the run against the applied community. Rejecting keeps the
   * flow on screen with a retry, so a failed handoff never strands anyone in
   * an empty app.
   */
  onComplete: (answers: OnboardingAnswers) => Promise<void>;
  /**
   * Explicit user exit toward email sign-in (the machine flow's
   * account-signin page). Offered only where the caller can honour it; the
   * host is left unfinished because onboarding simply did not happen here.
   */
  onRequestSignIn?: () => void;
};

export function NewOnboardingFlow({
  services,
  provisioning,
  onComplete,
  onRequestSignIn,
}: Props) {
  // Build-time flags never change mid-session, so both are read once.
  const canInvite = invitesEnabled(import.meta.env);
  // Resolved once per mount: the flow must not see a new services identity
  // mid-run (in-flight steps read it), for the same reason App memoises the
  // fakes it passes in.
  const [effectiveServices] = useState(() =>
    resolveAuthServices(import.meta.env, services),
  );
  const [reducedMotion] = useState(readReducedMotion);

  const [boot] = useState(() => {
    const loaded = loadAnswers(answerStorage);
    return { answers: loaded, step: resumeStep(loaded) };
  });
  const [answers, setAnswers] = useState<OnboardingAnswers>(boot.answers);
  const [step, setStep] = useState<OnboardingStep>(boot.step);

  const [accountValues, setAccountValues] = useState<AccountValues>({
    name: "",
    email: "",
    password: "",
    city: "",
    country: "",
    gender: null,
    selfDescribedGender: "",
    avatarUrl: "",
  });
  const [isSigningUp, setIsSigningUp] = useState(false);
  const [accountFailure, setAccountFailure] = useState<AuthFailure | null>(
    null,
  );
  const [acknowledged, setAcknowledged] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [pubkey, setPubkey] = useState("");
  const [companyValues, setCompanyValues] = useState<CompanyValues>({
    company: "",
  });
  const [companyState, setCompanyState] = useState<{
    status: "idle" | "provisioning" | "error";
    message?: string;
  }>({ status: "idle" });
  const [finishState, setFinishState] = useState<{
    status: "idle" | "running" | "error";
    message?: string;
  }>({ status: "idle" });

  const [trackResult, setTrackResult] = useState<TrackResult | null>(null);
  const [selectedBrain, setSelectedBrain] = useState<string | null>(null);

  const [businessStage, setBusinessStage] = useState<BusinessStage | null>(
    null,
  );
  const [hasWebsite, setHasWebsite] = useState<boolean | null>(null);
  const [website, setWebsite] = useState("");

  const [descriptionDraft, setDescriptionDraft] = useState("");
  const [scrapeFailed, setScrapeFailed] = useState(false);
  const [invites, setInvites] = useState<string[]>([]);
  const [isSendingInvites, setIsSendingInvites] = useState(false);

  const onCompleteRef = useRef(onComplete);
  useEffect(() => {
    onCompleteRef.current = onComplete;
  }, [onComplete]);

  /** Flow complete: hand the answers to the host, which sets the workspace
   *  up against the applied community, then drop the stored answers so a
   *  relaunch starts clean. Idempotent, because completion can be reached
   *  from several paths at once; a rejected handoff releases the latch so
   *  the user can try again rather than being stranded. */
  const finishedRef = useRef(false);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    setFinishState({ status: "running" });
    void onCompleteRef
      .current(answersRef.current)
      .then(() => {
        // Cleared only on success: a failed handoff must stay resumable.
        clearAnswers(answerStorage);
      })
      .catch((error: unknown) => {
        finishedRef.current = false;
        setFinishState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Something went wrong opening your workspace. Try again.",
        });
      });
  }, []);

  const goTo = useCallback(
    (target: OnboardingStep | "done") => {
      // An invite link has nowhere to land while the download button is off
      // the marketing site, so an invite target completes the flow instead.
      if (target === "done" || (target === "invite" && !canInvite)) {
        finish();
        return;
      }
      setStep(target);
    },
    [canInvite, finish],
  );

  // Covers a resume whose last completed screen was credits: the previous
  // build may have had invites on, this one does not.
  useEffect(() => {
    if (!canInvite && step === "invite") finish();
  }, [canInvite, step, finish]);

  useEffect(() => {
    saveAnswers(answerStorage, answers);
  }, [answers]);

  // The machine flow's config screen used to seed a brand-new account's agent
  // defaults when it mounted. That screen asked the brain question a second
  // time and is gone; the seeding was never the duplicated part, so it runs
  // here instead, at the top of the flow rather than at the brain screen. A
  // founder who abandons before picking still lands on a workspace whose
  // agents can start, and a founder who does pick overwrites it below.
  useEffect(() => {
    void applyFreshSignupDefaults().catch((error: unknown) => {
      console.warn("Could not seed fresh-signup agent defaults.", error);
    });
  }, []);

  const goBack = () => {
    const target = backStep(step);
    if (target) goTo(target);
  };

  const handleProbeResolved = useCallback((result: TrackResult) => {
    setTrackResult(result);
    // The brain screen always runs now. It used to be skipped whenever nothing
    // was installed, on the grounds that a list of one is not a choice — but
    // that was only true while the screen could do nothing except pick an
    // already-ready runtime. It installs and signs in now, so skipping it is
    // what would remove the choice.
    //
    // Preselect by fixed catalog order rather than detection luck, falling back
    // to the hosted agent, which is ready on every computer.
    setSelectedBrain(result.installed[0] ?? COLONY_AGENT_RUNTIME_ID);
    setAnswers((current) => ({ ...current, track: result.track }));
    setStep("brain");
  }, []);

  const handleAccountSubmit = async () => {
    if (!accountReady(accountValues) || isSigningUp) return;
    setIsSigningUp(true);
    setAccountFailure(null);
    try {
      const email = accountValues.email.trim();
      const result = await effectiveServices.auth.signUp(
        email,
        accountValues.password,
      );
      setRecoveryCode(result.recoveryCode);
      setPubkey(result.pubkey);
      const updated: OnboardingAnswers = {
        ...answers,
        account: { email },
        founder: {
          fullName: accountValues.name.trim(),
          city: accountValues.city.trim(),
          country: accountValues.country.trim(),
          gender: accountValues.gender,
          selfDescribedGender: accountValues.selfDescribedGender.trim(),
          avatarUrl: accountValues.avatarUrl.trim(),
        },
      };
      setAnswers(updated);
      goTo(nextStep("account", updated));
    } catch (thrown) {
      // authService throws the typed union; anything else still lands on the
      // generic retry state rather than vanishing. Either way the user stays
      // here with every field intact and the button re-enabled.
      setAccountFailure(
        typeof thrown === "object" && thrown !== null && "kind" in thrown
          ? (thrown as AuthFailure)
          : { kind: "unreachable" },
      );
    } finally {
      setIsSigningUp(false);
    }
  };

  const handleRecoveryContinue = () => {
    const updated = { ...answers, recoveryAcknowledged: true };
    setAnswers(updated);
    goTo(nextStep("recovery", updated));
  };

  const handleCompanySubmit = async () => {
    const name = companyValues.company.trim();
    if (!name || companyState.status === "provisioning") return;
    if (!provisioning) {
      // A community is already applied: nothing to claim, just record it.
      const updated: OnboardingAnswers = { ...answers, company: name };
      setAnswers(updated);
      goTo(nextStep("company", updated));
      return;
    }
    setCompanyState({ status: "provisioning" });
    const outcome = await provisioning.provision(name, answers.communitySlug);
    if (!outcome.ok) {
      setCompanyState({ status: "error", message: outcome.message });
      return;
    }
    provisioning.onProvisioned(outcome, name);
    setCompanyState({ status: "idle" });
    const updated: OnboardingAnswers = {
      ...answers,
      company: name,
      // Recorded so a reload resumes onto the address already claimed
      // instead of claiming a second one.
      communitySlug: outcome.slug,
    };
    setAnswers(updated);
    goTo(nextStep("company", updated));
  };

  const handleBrainContinue = () => {
    const chosen =
      selectedBrain ?? trackResult?.installed[0] ?? COLONY_AGENT_RUNTIME_ID;
    const updated: OnboardingAnswers = { ...answers, brain: chosen };
    setAnswers(updated);
    // Write the choice into the agent config the workspace actually starts
    // agents from. Recording it in `answers` alone left founders who picked
    // Claude Code with defaults still set to another runtime and no model, and
    // a Chief of Staff that never answered. Best effort: a failed config write
    // must not trap someone on this screen, and Agent defaults can fix it.
    void applyBrainChoice(chosen).catch((error: unknown) => {
      console.warn(
        "Could not apply the selected brain to agent defaults.",
        error,
      );
    });
    goTo(nextStep("brain", updated));
  };

  const handleBusinessChange = (patch: BusinessPatch) => {
    if (patch.stage !== undefined) setBusinessStage(patch.stage);
    if (patch.hasWebsite !== undefined) setHasWebsite(patch.hasWebsite);
    if (patch.website !== undefined) setWebsite(patch.website);
  };

  const handleBusinessContinue = (normalisedWebsite: string | null) => {
    const updated: OnboardingAnswers = {
      ...answers,
      stage: businessStage,
      hasWebsite,
      website: normalisedWebsite,
    };
    setAnswers(updated);
    goTo(nextStep("business", updated));
  };

  const handleReadingDone = useCallback((result: ScrapeResult) => {
    if (result.ok) setDescriptionDraft(result.description);
    setScrapeFailed(!result.ok);
    setStep("description");
  }, []);

  const handleDescriptionContinue = () => {
    const updated: OnboardingAnswers = {
      ...answers,
      description: descriptionDraft.trim(),
    };
    setAnswers(updated);
    goTo(nextStep("description", updated));
  };

  const handlePaid = () => {
    const updated: OnboardingAnswers = { ...answers, paid: true };
    setAnswers(updated);
    goTo(nextStep("credits", updated));
  };

  const handleCreditsSkip = () => {
    goTo(nextStep("credits", answers));
  };

  const handleInvitesSend = async () => {
    if (!invites.length || isSendingInvites) return;
    setIsSendingInvites(true);
    try {
      await effectiveServices.invites.invite(invites);
      finish();
    } finally {
      setIsSendingInvites(false);
    }
  };

  const { globalConfig } = useGlobalAgentConfig();
  const canvasTrack = trackResult?.track ?? answers.track ?? "colony";

  const body = (() => {
    switch (step) {
      case "account":
        return (
          <AccountScreen
            values={accountValues}
            onChange={(patch) => {
              setAccountValues((current) => ({ ...current, ...patch }));
              // A fresh attempt is a new question; drop the stale answer.
              setAccountFailure(null);
            }}
            onSubmit={handleAccountSubmit}
            isSubmitting={isSigningUp}
            failure={accountFailure}
            onSignInRequest={onRequestSignIn}
          />
        );
      case "recovery":
        return (
          <RecoveryScreen
            code={recoveryCode}
            acknowledged={acknowledged}
            onAcknowledge={setAcknowledged}
            onContinue={handleRecoveryContinue}
          />
        );
      case "company":
        return (
          <CompanyScreen
            values={companyValues}
            onChange={(patch) => {
              setCompanyValues((current) => ({ ...current, ...patch }));
              // Editing the name is a fresh attempt; drop the stale answer.
              setCompanyState({ status: "idle" });
            }}
            onSubmit={() => void handleCompanySubmit()}
            onBack={goBack}
            isSubmitting={companyState.status === "provisioning"}
            error={
              companyState.status === "error"
                ? (companyState.message ?? null)
                : null
            }
          />
        );
      case "probing":
        return (
          <ProbingScreen
            globalConfig={globalConfig}
            reducedMotion={reducedMotion}
            onResolved={handleProbeResolved}
          />
        );
      case "brain":
        if (trackResult === null) {
          // A resumed session has no probe result yet: probe again rather
          // than guess what was installed.
          return (
            <ProbingScreen
              globalConfig={globalConfig}
              reducedMotion={reducedMotion}
              onResolved={handleProbeResolved}
            />
          );
        }
        return (
          <BrainScreen
            brains={trackResult.brains}
            selected={
              selectedBrain ??
              trackResult.installed[0] ??
              COLONY_AGENT_RUNTIME_ID
            }
            onSelect={setSelectedBrain}
            onContinue={handleBrainContinue}
          />
        );
      case "business":
        return (
          <BusinessScreen
            stage={businessStage}
            hasWebsite={hasWebsite}
            website={website}
            onChange={handleBusinessChange}
            onContinue={handleBusinessContinue}
            onBack={goBack}
          />
        );
      case "reading":
        return (
          <ReadingScreen
            url={answers.website ?? ""}
            services={effectiveServices}
            reducedMotion={reducedMotion}
            onDone={handleReadingDone}
          />
        );
      case "description":
        return (
          <DescriptionScreen
            hasWebsite={answers.hasWebsite === true}
            scrapeFailed={scrapeFailed}
            value={descriptionDraft}
            onChange={setDescriptionDraft}
            onContinue={handleDescriptionContinue}
            onBack={goBack}
          />
        );
      case "credits":
        return (
          <CreditsScreen
            track={canvasTrack}
            email={answers.account?.email ?? ""}
            pubkey={pubkey}
            payments={effectiveServices.payments}
            onPaid={handlePaid}
            onSkip={handleCreditsSkip}
            onBack={goBack}
            finishing={finishState.status === "running"}
            finishError={
              finishState.status === "error"
                ? (finishState.message ?? null)
                : null
            }
            onRetryFinish={finish}
          />
        );
      case "invite":
        return canInvite ? (
          <InviteScreen
            invites={invites}
            onChange={setInvites}
            onSend={handleInvitesSend}
            onSkip={() => goTo(nextStep("invite", answers))}
            onBack={goBack}
            finishing={finishState.status === "running"}
            finishError={
              finishState.status === "error"
                ? (finishState.message ?? null)
                : null
            }
            onRetryFinish={finish}
          />
        ) : null;
      default:
        return null;
    }
  })();

  // Counted from the recorded answer rather than the live business-screen
  // state, so the total does not twitch while someone is still choosing.
  const position = stepPosition(step, {
    hasWebsite: answers.hasWebsite,
    invitesEnabled: canInvite,
  });

  return (
    <OnboardingCanvas
      step={step}
      track={canvasTrack}
      index={position.index}
      total={position.total}
    >
      {body}
    </OnboardingCanvas>
  );
}
