// desktop/src/features/onboarding/ui/new/NewOnboardingFlow.tsx
import { useCallback, useEffect, useRef, useState } from "react";

import { useGlobalAgentConfig } from "@/features/agents/useGlobalAgentConfig";
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from "@/shared/lib/safeStorage";
import type { AuthFailure } from "../../authService";
import { createWiredAuthService } from "../../lib/wiredAuthService";
import type { OnboardingServices, ScrapeResult } from "../../contracts";
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
import { InstallScreen, type InstallState } from "./screens/InstallScreen";
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

/**
 * There is no installer behind the Colony-agent step yet (contracts has no
 * install member), so the step is driven by a timed fake that mirrors the
 * reviewed prototype. The real installer replaces the timer, not the wiring.
 */
const FAKE_INSTALL_MS = 3400;
const FAKE_INSTALL_REDUCED_MS = 900;

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
function resolveAuthServices(
  env: Record<string, string | undefined>,
  passed: OnboardingServices,
): OnboardingServices {
  const real =
    env.VITE_NEW_ONBOARDING === "1" && env.MODE !== "e2e"
      ? createWiredAuthService()
      : null;
  const base = real === null ? passed : { ...passed, auth: real };
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

type Props = {
  services: OnboardingServices;
  onComplete: () => void;
};

export function NewOnboardingFlow({ services, onComplete }: Props) {
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

  const [trackResult, setTrackResult] = useState<TrackResult | null>(null);
  const [selectedBrain, setSelectedBrain] = useState<string | null>(null);
  const [installState, setInstallState] = useState<InstallState>("running");

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

  /** Flow complete: drop the stored answers so a relaunch starts clean, then
   *  hand control back to the app. Idempotent, because completion can be
   *  reached from several paths at once. */
  const finishedRef = useRef(false);
  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    clearAnswers(answerStorage);
    onCompleteRef.current();
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

  const goBack = () => {
    const target = backStep(step);
    if (target) goTo(target);
  };

  const handleProbeResolved = useCallback((result: TrackResult) => {
    setTrackResult(result);
    // Spec: one runtime preselected, by fixed catalog order not detection luck.
    setSelectedBrain(result.installed[0] ?? null);
    setAnswers((current) => ({ ...current, track: result.track }));
    setStep("brain");
  }, []);

  const settleInstall = useCallback((state: InstallState) => {
    setInstallState(state);
    if (state === "done" || state === "degraded") {
      // The colony branch has no named brain; recording one keeps resume from
      // bouncing through this step again.
      setAnswers((current) => ({
        ...current,
        brain: current.brain ?? "colony",
      }));
      setStep("business");
    }
  }, []);

  useEffect(() => {
    if (step !== "brain" || installState !== "running") return undefined;
    if (trackResult !== null && trackResult.installed.length > 0) {
      return undefined;
    }
    const id = setTimeout(
      () => settleInstall("done"),
      reducedMotion ? FAKE_INSTALL_REDUCED_MS : FAKE_INSTALL_MS,
    );
    return () => clearTimeout(id);
  }, [step, installState, trackResult, reducedMotion, settleInstall]);

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

  const handleCompanySubmit = () => {
    const name = companyValues.company.trim();
    if (!name) return;
    const updated: OnboardingAnswers = { ...answers, company: name };
    setAnswers(updated);
    goTo(nextStep("company", updated));
  };

  const handleBrainContinue = () => {
    const chosen = selectedBrain ?? trackResult?.installed[0];
    if (!chosen) return;
    const updated: OnboardingAnswers = { ...answers, brain: chosen };
    setAnswers(updated);
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
            onChange={(patch) =>
              setCompanyValues((current) => ({ ...current, ...patch }))
            }
            onSubmit={handleCompanySubmit}
            onBack={goBack}
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
        if (trackResult.installed.length === 0) {
          // The brain picker only makes sense when something usable was
          // found. The colony branch installs its own agent instead.
          return (
            <InstallScreen
              state={installState}
              onRetry={() => setInstallState("running")}
              onContinueAnyway={() => settleInstall("degraded")}
            />
          );
        }
        return (
          <BrainScreen
            brains={trackResult.brains}
            selected={selectedBrain ?? trackResult.installed[0]}
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
            services={effectiveServices}
            onPaid={handlePaid}
            onSkip={handleCreditsSkip}
            onBack={goBack}
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
          />
        ) : null;
      default:
        return null;
    }
  })();

  return (
    <OnboardingCanvas step={step} track={canvasTrack}>
      {body}
    </OnboardingCanvas>
  );
}
