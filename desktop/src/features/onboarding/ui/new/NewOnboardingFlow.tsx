import {
  useCallback,
  useEffect,
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
  onComplete: (answers: OnboardingAnswers) => Promise<void>;
  onRequestSignIn?: () => void;
  existingIdentity?: boolean;
  onLeaveRun?: () => void;
  answersKey?: string;
  currentPubkey?: string;
  canvasOverlay?: ReactNode;
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
        next = {
          ...next,
          account: { email: restored.email },
          signupAttemptId: restored.attemptId,
          identityPubkey: restored.pubkey,
        };
        persist(next);
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

  async function accountCreated(result: SignUpResult, email: string) {
    persist({
      ...answersRef.current,
      account: { email },
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
            next = { ...next, provisioningCandidate: candidate };
            persist(next);
          },
        );
        if (!result.ok) throw new Error(result.message);
        next = { ...next, communitySlug: result.slug };
        persist(next);
        provisioning.onProvisioned(result, next.company ?? "");
      }
      await onComplete(next);
      clearAnswers(answerStorage, answersKey);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "We could not finish opening your business. Try again.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const step = resumeStep(answers);
  const basePosition = stepPosition(step, {
    invitesEnabled: false,
    creditsNeeded: false,
  });
  const position = existingIdentity ? { index: 0, total: 1 } : basePosition;
  return (
    <OnboardingCanvas
      step={step}
      track="colony"
      {...position}
      overlay={canvasOverlay}
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
      ) : (
        <CompanyScreen
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
