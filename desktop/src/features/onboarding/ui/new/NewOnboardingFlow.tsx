// desktop/src/features/onboarding/ui/new/NewOnboardingFlow.tsx
import { useCallback, useEffect, useRef, useState } from "react";

import { useGlobalAgentConfig } from "@/features/agents/useGlobalAgentConfig";
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from "@/shared/lib/safeStorage";
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

type Props = {
  services: OnboardingServices;
  onComplete: () => void;
};

export function NewOnboardingFlow({ services, onComplete }: Props) {
  // Build-time flags never change mid-session, so both are read once.
  const canInvite = invitesEnabled(import.meta.env);
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
    try {
      const email = accountValues.email.trim();
      const result = await services.auth.signUp(email, accountValues.password);
      setRecoveryCode(result.recoveryCode);
      setPubkey(result.pubkey);
      const updated: OnboardingAnswers = {
        ...answers,
        account: { email },
      };
      setAnswers(updated);
      goTo(nextStep("account", updated));
    } catch {
      // Sign-up failed: stay here with the button re-enabled so the user can
      // simply try again.
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
      await services.invites.invite(invites);
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
            onChange={(patch) =>
              setAccountValues((current) => ({ ...current, ...patch }))
            }
            onSubmit={handleAccountSubmit}
            isSubmitting={isSigningUp}
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
            installed={trackResult.installed}
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
            services={services}
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
            services={services}
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
