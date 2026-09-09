import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  getStorageItem,
  removeStorageItem,
  setStorageItem,
} from "@/shared/lib/safeStorage";
import type { AuthFailure } from "../../authService";
import type {
  OnboardingServices,
  PendingSignup,
  SignUpResult,
} from "../../contracts";
import { createWiredAuthService } from "../../lib/wiredAuthService";
import { createWiredScrapeService } from "../../lib/wiredScrapeService";
import { createWiredPaymentsService } from "../../lib/wiredPaymentsService";
import {
  clearAnswers,
  loadAnswers,
  saveAnswers,
  type AnswerStorage,
} from "../../flow/persistence";
import {
  resumeStep,
  stepPosition,
  type OnboardingAnswers,
} from "../../flow/steps";
import type { ProvisionOutcome } from "../../flow/provisionWorkspace";
import { AccountSetup } from "./AccountSetup";
import { OnboardingCanvas } from "./OnboardingCanvas";
import { RecoveryScreen } from "./screens/RecoveryScreen";
import { CompanyScreen } from "./screens/CompanyScreen";
import { PowerScreen } from "./screens/PowerScreen";
import {
  clearAccountNameDraft,
  founderWithName,
  readAccountNameDraft,
} from "../../accountNameDraft";

export const answerStorage: AnswerStorage = {
  get: getStorageItem,
  set: setStorageItem,
  remove: (key) => void removeStorageItem(key),
};

/** Production always uses the real native/account services; fakes are E2E only. */
export function resolveAuthServices(
  env: Record<string, string | undefined>,
  passed: OnboardingServices,
): OnboardingServices {
  const base =
    env.MODE === "e2e"
      ? passed
      : {
          ...passed,
          auth: createWiredAuthService(),
          scrape: createWiredScrapeService(),
          payments: createWiredPaymentsService(),
        };
  if (env.MODE !== "e2e") return base;
  try {
    const raw = getStorageItem("colony.e2e.authFailure");
    const failure: AuthFailure | null = raw ? JSON.parse(raw) : null;
    if (failure && typeof failure.kind === "string")
      return {
        ...base,
        auth: {
          ...base.auth,
          signUp: async () => {
            throw failure;
          },
        },
      };
  } catch {
    /* Missing E2E override leaves the ordinary fixture active. */
  }
  return base;
}

export type OnboardingProvisioning = {
  provision: (
    companyName: string,
    storedSlug: string | null,
    rememberCandidate: (slug: string | null) => void,
  ) => Promise<ProvisionOutcome>;
  onProvisioned: (
    outcome: Extract<ProvisionOutcome, { ok: true }>,
    companyName: string,
  ) => void;
};

type Props = {
  services: OnboardingServices;
  provisioning: OnboardingProvisioning | null;
  onComplete: (
    answers: OnboardingAnswers,
    isCurrentRun: () => boolean,
  ) => Promise<void>;
  onRequestSignIn?: () => void;
  existingIdentity?: boolean;
  onLeaveRun?: () => void;
  answersKey?: string;
  currentPubkey?: string;
  canvasOverlay?: ReactNode;
  onPreparePower?: (assertCurrent: () => void) => Promise<string>;
  expectedRelayUrl?: string;
};

export function NewOnboardingFlow({
  services,
  provisioning,
  onComplete,
  onRequestSignIn,
  existingIdentity = false,
  onLeaveRun,
  answersKey,
  currentPubkey,
  canvasOverlay,
  onPreparePower,
  expectedRelayUrl,
}: Props) {
  const [effectiveServices] = useState(() =>
    resolveAuthServices(import.meta.env, services),
  );
  const [answers, setAnswers] = useState<OnboardingAnswers>(() => {
    const loaded = loadAnswers(answerStorage, answersKey);
    return existingIdentity
      ? {
          ...loaded,
          account: loaded.account ?? { email: "" },
          recoveryAcknowledged: true,
        }
      : loaded;
  });
  const answersRef = useRef(answers);
  const [pending, setPending] = useState<PendingSignup | null>(null);
  const [loadingRecovery, setLoadingRecovery] = useState(!existingIdentity);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const activeRun = useRef<symbol | null>(null);
  const mounted = useRef(false);
  const scopeRef = useRef({ answersKey, currentPubkey });
  useLayoutEffect(() => {
    scopeRef.current = { answersKey, currentPubkey };
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeRun.current = null;
      running.current = false;
    };
  }, [answersKey, currentPubkey]);
  const persist = useCallback(
    (next: OnboardingAnswers) => {
      saveAnswers(answerStorage, next, answersKey);
      answersRef.current = next;
      setAnswers(next);
    },
    [answersKey],
  );

  const restoreRecovery = useCallback(async () => {
    if (existingIdentity) return;
    setLoadingRecovery(true);
    setRecoveryError(null);
    try {
      const restored = await effectiveServices.auth.pendingSignup();
      setPending(restored);
      // Migrate an unscoped older draft only when native identity-bound
      // account evidence matches. Never carry one person's company to another.
      let next = answersRef.current;
      if (!next.account && restored && answersKey) {
        const legacy = loadAnswers(answerStorage);
        if (
          legacy.account?.email.trim().toLowerCase() === restored.email &&
          (!legacy.identityPubkey || legacy.identityPubkey === restored.pubkey)
        )
          next = legacy;
      }
      if (!next.account && !restored && answersKey) {
        const legacy = loadAnswers(answerStorage);
        if (
          legacy.account &&
          !legacy.recoveryAcknowledged &&
          (!legacy.identityPubkey || legacy.identityPubkey === currentPubkey)
        ) {
          // Preserve the old checkpoint, but never invent its lost code or
          // proceed to provisioning. The recovery screen offers sign-in.
          next = { ...legacy, identityPubkey: currentPubkey ?? null };
          persist(next);
        }
      }
      if (restored?.phase === "registered") {
        // This effect can resume directly into recovery before AccountSetup's
        // pending-signup callback runs. Carry its public name across that race.
        const recoveredName = readAccountNameDraft(
          answerStorage,
          restored.email,
        );
        next = {
          ...next,
          account: { email: restored.email },
          founder: founderWithName(
            next.founder,
            next.founder?.fullName.trim() || recoveredName,
          ),
          signupAttemptId: restored.attemptId,
          identityPubkey: restored.pubkey,
        };
        persist(next);
        clearAccountNameDraft(answerStorage, restored.email);
        if (next.recoveryAcknowledged)
          await effectiveServices.auth.acknowledgeRecovery(restored.attemptId);
      }
    } catch {
      setRecoveryError(
        "We could not open your saved recovery code. Try again.",
      );
    } finally {
      setLoadingRecovery(false);
    }
  }, [effectiveServices, existingIdentity, answersKey, currentPubkey, persist]);
  useEffect(() => {
    void restoreRecovery();
  }, [restoreRecovery]);

  async function accountCreated(
    result: SignUpResult,
    email: string,
    fullName: string,
  ) {
    if (currentPubkey && currentPubkey !== result.pubkey)
      throw new Error("The account changed during signup. Reopen setup.");
    persist({
      ...answersRef.current,
      account: { email },
      founder: founderWithName(answersRef.current.founder, fullName),
      signupAttemptId: result.attemptId,
      identityPubkey: currentPubkey ?? result.pubkey,
    });
    setPending({ ...result, email, phase: "registered" });
  }
  async function acknowledgeRecovery() {
    if (
      !pending ||
      pending.phase !== "registered" ||
      !pending.recoveryCode.trim()
    )
      throw new Error("Recovery code unavailable");
    const updated = { ...answersRef.current, recoveryAcknowledged: true };
    // Persist the successful backup acknowledgement before clearing its
    // secret. A crash between them leaves safe, repeatable cleanup.
    saveAnswers(answerStorage, updated, answersKey);
    await effectiveServices.auth.acknowledgeRecovery(pending.attemptId);
    persist(updated);
    setPending(null);
  }
  async function finishBusiness(website: string | null) {
    if (running.current) return;
    running.current = true;
    const run = Symbol("onboarding-submit");
    activeRun.current = run;
    const isCurrentRun = () =>
      mounted.current &&
      activeRun.current === run &&
      scopeRef.current.answersKey === answersKey &&
      scopeRef.current.currentPubkey === currentPubkey;
    setBusy(true);
    setError(null);
    try {
      let next = {
        ...answersRef.current,
        website,
        hasWebsite: !!website,
        firstTaskMarker:
          answersRef.current.firstTaskMarker ?? crypto.randomUUID(),
      };
      persist(next);
      if (provisioning) {
        const result = await provisioning.provision(
          next.company?.trim() ?? "",
          next.communitySlug ?? next.provisioningCandidate ?? null,
          (candidate) => {
            // Refuse a create that has not started yet after the owner leaves.
            // Candidates already persisted before a request remain resumable.
            if (!isCurrentRun()) throw new Error("This setup run has ended");
            next = { ...next, provisioningCandidate: candidate };
            persist(next);
          },
        );
        if (!isCurrentRun()) return;
        if (!result.ok) throw new Error(result.message);
        next = { ...next, communitySlug: result.slug };
        persist(next);
        provisioning.onProvisioned(result, next.company ?? "");
      }
      if (!isCurrentRun()) return;
      await onPreparePower?.(() => {
        if (!isCurrentRun()) throw new Error("This setup run has ended");
      });
      if (!isCurrentRun()) return;
      persist({ ...next, businessConfirmed: true });
    } catch (cause) {
      if (!isCurrentRun()) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "We could not finish opening your business. Try again.",
      );
    } finally {
      if (isCurrentRun()) {
        activeRun.current = null;
        running.current = false;
        setBusy(false);
      }
    }
  }
  async function finishPower(save: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    const run = Symbol("onboarding-power");
    activeRun.current = run;
    const isCurrentRun = () =>
      mounted.current &&
      activeRun.current === run &&
      scopeRef.current.answersKey === answersKey &&
      scopeRef.current.currentPubkey === currentPubkey;
    setBusy(true);
    setError(null);
    try {
      if (!isCurrentRun()) return;
      await save();
      if (!isCurrentRun()) return;
      await onComplete(answersRef.current, isCurrentRun);
      // Completion may unmount this flow. Its successful handoff has already
      // checked the run; remove only this run's captured storage key.
      clearAnswers(answerStorage, answersKey);
    } catch (cause) {
      if (isCurrentRun())
        setError(
          cause instanceof Error
            ? cause.message
            : typeof cause === "string"
              ? cause
              : "We could not finish setting up your agents. Try again.",
        );
    } finally {
      if (isCurrentRun()) {
        activeRun.current = null;
        running.current = false;
        setBusy(false);
      }
    }
  }
  const step = resumeStep(answers);
  const powerScopeKey = JSON.stringify([
    answersKey,
    currentPubkey,
    answers.communitySlug,
  ]);
  const basePosition = stepPosition(step, {
    invitesEnabled: false,
    creditsNeeded: false,
  });
  const position = existingIdentity
    ? { index: step === "brain" ? 1 : 0, total: 2 }
    : basePosition;
  return (
    <OnboardingCanvas
      step={step}
      track="colony"
      {...position}
      overlay={
        canvasOverlay ? (
          <fieldset disabled={busy} className="contents">
            {canvasOverlay}
          </fieldset>
        ) : undefined
      }
    >
      {step === "account" ? (
        <AccountSetup
          auth={effectiveServices.auth}
          onCreated={accountCreated}
          onSignIn={onRequestSignIn}
        />
      ) : step === "recovery" ? (
        <RecoveryScreen
          code={pending?.phase === "registered" ? pending.recoveryCode : ""}
          loading={loadingRecovery}
          loadError={recoveryError}
          onRetry={recoveryError ? () => void restoreRecovery() : undefined}
          onSignIn={onRequestSignIn}
          onSave={() =>
            pending
              ? effectiveServices.auth.saveRecovery(pending.attemptId)
              : Promise.reject(new Error("Recovery unavailable"))
          }
          onContinue={acknowledgeRecovery}
        />
      ) : step === "brain" ? (
        <PowerScreen
          key={powerScopeKey}
          scopeKey={powerScopeKey}
          expectedOwnerPubkey={currentPubkey}
          expectedRelayUrl={expectedRelayUrl}
          prepareScope={onPreparePower}
          businessOnly={existingIdentity}
          busy={busy}
          error={error}
          onBack={() => {
            persist({ ...answersRef.current, businessConfirmed: false });
            setError(null);
          }}
          onContinue={finishPower}
        />
      ) : (
        <CompanyScreen
          onSignIn={onRequestSignIn}
          businessOnly={existingIdentity}
          values={{
            company: answers.company ?? "",
            website: answers.website ?? "",
            description: answers.description ?? "",
          }}
          onChange={(patch) => {
            const next = { ...answersRef.current, ...patch };
            try {
              persist(next);
              setError(null);
            } catch (cause) {
              answersRef.current = next;
              setAnswers(next);
              setError(
                cause instanceof Error
                  ? cause.message
                  : "We could not save your progress.",
              );
            }
          }}
          onSubmit={(website) => void finishBusiness(website)}
          onBack={existingIdentity && !canvasOverlay ? onLeaveRun : undefined}
          isSubmitting={busy}
          error={error}
          scrape={effectiveServices.scrape}
        />
      )}
    </OnboardingCanvas>
  );
}
