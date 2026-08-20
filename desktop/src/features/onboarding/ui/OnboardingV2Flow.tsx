import * as React from "react";
import { Check, ChevronLeft, Globe2, Sparkles } from "lucide-react";

import {
  useAcpRuntimesQuery,
  useInstallAcpRuntimeMutation,
} from "@/features/agents/hooks";
import {
  configForAutomaticCli,
  defaultColonyAgentConfig,
  selectAutomaticRuntime,
} from "@/features/onboarding/automaticRuntime";
import {
  founderDetailsAreValid,
  isValidBusinessWebsite,
  shouldStartWebsiteScan,
  type FounderGender,
  type OnboardingV2Draft,
} from "@/features/onboarding/onboardingV2";
import {
  buildEditableCompanySummary,
  scanOnboardingCompanyWebsite,
} from "@/shared/api/tauriCompanyScan";
import {
  getGlobalAgentConfig,
  setGlobalAgentConfig,
} from "@/shared/api/tauriGlobalAgentConfig";
import { getColonyCreditsAccount } from "@/shared/api/tauriProvisionedCredits";
import { updateProfile } from "@/shared/api/tauriProfiles";
import { Button } from "@/shared/ui/button";
import { AntMark } from "@/shared/ui/colony-logo/AntMark";
import { Input } from "@/shared/ui/input";
import { ONBOARDING_COUNTRIES } from "./onboardingV2Countries";
import { OnboardingV2Shell, OnboardingV2Status } from "./OnboardingV2Shell";

const GENDER_OPTIONS: Array<{ value: FounderGender; label: string }> = [
  { value: "woman", label: "Woman" },
  { value: "man", label: "Man" },
  { value: "non-binary", label: "Non-binary" },
  { value: "self-describe", label: "Self-describe" },
  { value: "prefer-not-to-say", label: "Prefer not to say" },
];

const FIVE_DOLLARS_NANOUSD = 5_000_000_000n;

function Heading({
  kicker,
  title,
  children,
}: {
  kicker: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="buzz-onboarding-v2__heading">
      <span>{kicker}</span>
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  );
}

function ErrorNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="buzz-onboarding-v2__error" role="alert">
      {children}
    </p>
  );
}

export function OnboardingV2Flow({
  draft,
  onChange,
  onReadyToFinalize,
  externalError,
  isFinalizing = false,
  paymentSetupAvailable = false,
  onStartPaymentSetup,
}: {
  draft: OnboardingV2Draft;
  onChange: (draft: OnboardingV2Draft) => void;
  onReadyToFinalize: () => Promise<void>;
  externalError?: string;
  isFinalizing?: boolean;
  paymentSetupAvailable?: boolean;
  onStartPaymentSetup?: () => Promise<void>;
}) {
  const runtimes = useAcpRuntimesQuery({
    enabled: draft.stage === "runtime-check",
  });
  const installRuntime = useInstallAcpRuntimeMutation();
  const [error, setError] = React.useState<string | null>(null);
  const scanGeneration = React.useRef(0);

  const patch = React.useCallback(
    (next: Partial<OnboardingV2Draft>) => onChange({ ...draft, ...next }),
    [draft, onChange],
  );

  const patchFounder = React.useCallback(
    (next: Partial<OnboardingV2Draft["founder"]>) =>
      patch({ founder: { ...draft.founder, ...next } }),
    [draft.founder, patch],
  );
  const patchCompany = React.useCallback(
    (next: Partial<OnboardingV2Draft["company"]>) =>
      patch({ company: { ...draft.company, ...next } }),
    [draft.company, patch],
  );

  React.useEffect(() => {
    if (!shouldStartWebsiteScan(draft.stage, draft.company.scanStatus)) return;
    const generation = ++scanGeneration.current;
    setError(null);
    patchCompany({ scanStatus: "running" });
    void scanOnboardingCompanyWebsite(draft.company.website)
      .then((result) => {
        if (scanGeneration.current !== generation) return;
        if (result.status === "success") {
          onChange({
            ...draft,
            stage: "summary",
            company: {
              ...draft.company,
              canonicalUrl: result.result.canonicalUrl,
              summary: buildEditableCompanySummary(result.result),
              scanStatus: "success",
            },
          });
          return;
        }
        onChange({
          ...draft,
          stage: "description",
          company: {
            ...draft.company,
            scanStatus: result.status === "timeout" ? "timeout" : "failed",
          },
        });
      })
      .catch((cause) => {
        if (scanGeneration.current !== generation) return;
        setError(
          cause instanceof Error ? cause.message : "The scan could not finish.",
        );
        patchCompany({ scanStatus: "failed" });
      });
  }, [draft, onChange, patchCompany]);

  React.useEffect(() => {
    if (draft.stage !== "runtime-check" || runtimes.isPending || !runtimes.data)
      return;
    let cancelled = false;
    const configure = async () => {
      setError(null);
      const choice = selectAutomaticRuntime(runtimes.data);
      try {
        const current = await getGlobalAgentConfig();
        if (choice.route === "cli") {
          await setGlobalAgentConfig(
            configForAutomaticCli(current, choice.runtimeId),
          );
          if (!cancelled) {
            onChange({
              ...draft,
              stage: "runtime-ready",
              runtime: {
                ...draft.runtime,
                route: "cli",
                selectedId: choice.runtimeId,
              },
            });
          }
          return;
        }
        if (!cancelled) {
          onChange({
            ...draft,
            stage: "agent-install",
            runtime: {
              ...draft.runtime,
              route: "colony-agent",
              selectedId: choice.runtimeId,
            },
          });
        }
      } catch (cause) {
        if (!cancelled)
          setError(
            cause instanceof Error ? cause.message : "Automatic setup failed.",
          );
      }
    };
    void configure();
    return () => {
      cancelled = true;
    };
  }, [draft, onChange, runtimes.data, runtimes.isPending]);

  const continueFromCompany = () => {
    if (!draft.company.summary.trim()) return;
    setError(null);
    patch({ stage: "runtime-check" });
  };

  const saveFounder = async () => {
    if (!founderDetailsAreValid(draft.founder)) return;
    setError(null);
    try {
      await updateProfile({ displayName: draft.founder.fullName.trim() });
      patch({ stage: "website" });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your details could not be saved.",
      );
    }
  };

  const installColonyAgent = async () => {
    setError(null);
    try {
      await installRuntime.mutateAsync("buzz-agent");
      const current = await getGlobalAgentConfig();
      await setGlobalAgentConfig(defaultColonyAgentConfig(current));
      try {
        const account = await getColonyCreditsAccount();
        if (BigInt(account.balance_nanousd) >= FIVE_DOLLARS_NANOUSD) {
          patch({ stage: "model" });
          return;
        }
      } catch {
        // A missing account proceeds to the explicit payment step.
      }
      patch({ stage: "payment-method" });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Colony Agent could not be installed.",
      );
    }
  };

  const startPayment = async () => {
    if (!onStartPaymentSetup) return;
    setError(null);
    try {
      await onStartPaymentSetup();
      patch({ stage: "credits" });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your payment method was not linked.",
      );
    }
  };

  const checkCredits = async () => {
    setError(null);
    try {
      const account = await getColonyCreditsAccount();
      if (BigInt(account.balance_nanousd) < FIVE_DOLLARS_NANOUSD) {
        setError(
          "Your $5 credit is still processing. Check again in a moment.",
        );
        return;
      }
      patch({ stage: "model" });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Credits are not ready yet.",
      );
    }
  };

  const content = (() => {
    switch (draft.stage) {
      case "founder":
        return (
          <>
            <Heading kicker="Step 1 of 7" title="Let’s start with you">
              A few human details help Scout understand who it is working with.
            </Heading>
            <div className="buzz-onboarding-v2__form-grid">
              <label className="is-wide" htmlFor="onboarding-founder-name">
                <span>Full name</span>
                <Input
                  autoFocus
                  id="onboarding-founder-name"
                  value={draft.founder.fullName}
                  onChange={(event) =>
                    patchFounder({ fullName: event.target.value })
                  }
                  placeholder="Your full name"
                />
              </label>
              <label htmlFor="onboarding-founder-country">
                <span>Country</span>
                <select
                  id="onboarding-founder-country"
                  value={draft.founder.country}
                  onChange={(event) =>
                    patchFounder({ country: event.target.value })
                  }
                >
                  <option value="">Choose country</option>
                  {ONBOARDING_COUNTRIES.map((country) => (
                    <option key={country} value={country}>
                      {country}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor="onboarding-founder-city">
                <span>City</span>
                <Input
                  id="onboarding-founder-city"
                  value={draft.founder.city}
                  onChange={(event) =>
                    patchFounder({ city: event.target.value })
                  }
                  placeholder="Your city"
                />
              </label>
              <fieldset className="is-wide">
                <legend>
                  Gender <small>optional</small>
                </legend>
                <div className="buzz-onboarding-v2__chips">
                  {GENDER_OPTIONS.map((option) => (
                    <button
                      className={
                        draft.founder.gender === option.value
                          ? "is-selected"
                          : ""
                      }
                      key={option.value}
                      onClick={() => patchFounder({ gender: option.value })}
                      type="button"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </fieldset>
              {draft.founder.gender === "self-describe" ? (
                <label
                  className="is-wide"
                  htmlFor="onboarding-founder-gender-description"
                >
                  <span>How should we describe you?</span>
                  <Input
                    id="onboarding-founder-gender-description"
                    value={draft.founder.selfDescribedGender}
                    onChange={(event) =>
                      patchFounder({ selfDescribedGender: event.target.value })
                    }
                  />
                </label>
              ) : null}
            </div>
            {error ? <ErrorNotice>{error}</ErrorNotice> : null}
            <Button
              className="buzz-onboarding-v2__primary"
              disabled={!founderDetailsAreValid(draft.founder)}
              onClick={() => void saveFounder()}
            >
              Continue
            </Button>
          </>
        );
      case "website":
        return (
          <>
            <Heading kicker="Step 2 of 7" title="Show Colony your business">
              We will read your public website and turn it into a summary you
              control.
            </Heading>
            <label
              className="buzz-onboarding-v2__single-field"
              htmlFor="onboarding-business-website"
            >
              <span>Business website</span>
              <div>
                <Globe2 aria-hidden="true" />
                <Input
                  autoFocus
                  id="onboarding-business-website"
                  value={draft.company.website}
                  onChange={(event) =>
                    patchCompany({ website: event.target.value })
                  }
                  placeholder="https://yourcompany.com"
                />
              </div>
            </label>
            {draft.company.website.trim() &&
            !isValidBusinessWebsite(draft.company.website) ? (
              <ErrorNotice>
                Enter a public HTTPS website, for example
                https://yourcompany.com.
              </ErrorNotice>
            ) : null}
            {error ? <ErrorNotice>{error}</ErrorNotice> : null}
            <Button
              className="buzz-onboarding-v2__primary"
              disabled={!isValidBusinessWebsite(draft.company.website)}
              onClick={() => {
                setError(null);
                patch({
                  stage: "scan",
                  company: {
                    ...draft.company,
                    hasWebsite: true,
                    scanStatus: "idle",
                  },
                });
              }}
            >
              Scan my website
            </Button>
            <button
              className="buzz-onboarding-v2__text-button"
              onClick={() =>
                patch({
                  stage: "description",
                  company: {
                    ...draft.company,
                    hasWebsite: false,
                    scanStatus: "idle",
                  },
                })
              }
              type="button"
            >
              I do not have a website
            </button>
          </>
        );
      case "scan":
        return (
          <>
            <Heading
              kicker="Learning your company"
              title="Colony is reading the signals"
            >
              This can take up to five minutes. Stay here while we map what your
              business does.
            </Heading>
            <OnboardingV2Status
              label="Scanning your website"
              detail="Reading the offer, customers, voice, and public company facts."
            />
            {error ? (
              <>
                <ErrorNotice>{error}</ErrorNotice>
                <Button
                  className="buzz-onboarding-v2__primary"
                  onClick={() => patchCompany({ scanStatus: "idle" })}
                >
                  Try again
                </Button>
              </>
            ) : null}
          </>
        );
      case "summary":
      case "description": {
        const scanFailed =
          draft.stage === "description" && draft.company.hasWebsite;
        return (
          <>
            <Heading
              kicker="Step 3 of 7"
              title={
                draft.stage === "summary"
                  ? "Is this your business?"
                  : scanFailed
                    ? "Tell Colony about your business"
                    : "Describe your business"
              }
            >
              {draft.stage === "summary"
                ? "Edit anything the scan got wrong. This becomes Scout’s starting context."
                : draft.company.scanStatus === "timeout"
                  ? "The five-minute scan ended before we had a reliable answer. A short description keeps you moving."
                  : "A clear paragraph is enough. You can improve it with Scout later."}
            </Heading>
            <label className="buzz-onboarding-v2__textarea">
              <span>Business summary</span>
              <textarea
                value={draft.company.summary}
                onChange={(event) =>
                  patchCompany({ summary: event.target.value })
                }
                placeholder="What do you sell, who do you serve, and what makes the business distinctive?"
              />
            </label>
            <Button
              className="buzz-onboarding-v2__primary"
              disabled={!draft.company.summary.trim()}
              onClick={continueFromCompany}
            >
              This is right
            </Button>
            {draft.company.hasWebsite ? (
              <button
                className="buzz-onboarding-v2__text-button"
                onClick={() => patch({ stage: "website" })}
                type="button"
              >
                Try a different website
              </button>
            ) : null}
          </>
        );
      }
      case "runtime-check":
        return (
          <>
            <Heading
              kicker="Step 4 of 7"
              title="Finding the best way to run your team"
            >
              Colony is checking this computer and choosing the simplest ready
              setup.
            </Heading>
            <OnboardingV2Status
              label="Checking your computer"
              detail="No technical choices needed."
            />
            {runtimes.isError || error ? (
              <>
                <ErrorNotice>
                  {error ?? "The automatic check could not finish."}
                </ErrorNotice>
                <Button
                  className="buzz-onboarding-v2__primary"
                  onClick={() => void runtimes.refetch()}
                >
                  Check again
                </Button>
              </>
            ) : null}
          </>
        );
      case "runtime-ready":
        return (
          <>
            <Heading kicker="Ready" title="Your existing AI setup works">
              Colony found a signed-in AI tool on this computer and connected it
              automatically. There is nothing to buy.
            </Heading>
            <div className="buzz-onboarding-v2__success">
              <Check aria-hidden="true" />
              <span>{draft.runtime.selectedId} is ready</span>
            </div>
            <Button
              className="buzz-onboarding-v2__primary"
              onClick={() => patch({ stage: "scout" })}
            >
              Bring Scout online
            </Button>
          </>
        );
      case "agent-install":
        return (
          <>
            <Heading
              kicker="Colony Agent"
              title="Install your company’s engine"
            >
              No ready AI tool was found. Colony Agent is the secure managed
              option and takes care of the technical setup.
            </Heading>
            <div className="buzz-onboarding-v2__feature">
              <Sparkles aria-hidden="true" />
              <div>
                <strong>Automatic installation</strong>
                <p>
                  Signed runtime, managed model access, and a $5 starting
                  balance.
                </p>
              </div>
            </div>
            {error ? <ErrorNotice>{error}</ErrorNotice> : null}
            <Button
              className="buzz-onboarding-v2__primary"
              disabled={installRuntime.isPending}
              onClick={() => void installColonyAgent()}
            >
              {installRuntime.isPending
                ? "Installing Colony Agent…"
                : "Install Colony Agent"}
            </Button>
          </>
        );
      case "payment-method":
        return (
          <>
            <Heading kicker="Step 5 of 7" title="Link a card to add $5">
              Your card keeps the company running after the first $5. Colony
              never exposes payment details to agents.
            </Heading>
            {error ? <ErrorNotice>{error}</ErrorNotice> : null}
            <Button
              className="buzz-onboarding-v2__primary"
              disabled={!paymentSetupAvailable}
              onClick={() => void startPayment()}
            >
              {paymentSetupAvailable
                ? "Link card securely"
                : "Secure payment setup coming online"}
            </Button>
            <p className="buzz-onboarding-v2__fine-print">
              No charge repeats without your approval.
            </p>
          </>
        );
      case "credits":
        return (
          <>
            <Heading
              kicker="Funding your company"
              title="Confirming your $5 credit"
            >
              Payment providers can take a moment to confirm. Colony will not
              create a duplicate charge.
            </Heading>
            <OnboardingV2Status label="Waiting for confirmation" />
            {error ? <ErrorNotice>{error}</ErrorNotice> : null}
            <Button
              className="buzz-onboarding-v2__secondary"
              onClick={() => void checkCredits()}
            >
              Check again
            </Button>
          </>
        );
      case "model":
        return (
          <>
            <Heading kicker="Model" title="Choose your company’s first brain">
              DeepSeek V4 Flash is selected for speed and value. You can change
              this later in Settings.
            </Heading>
            <button
              className="buzz-onboarding-v2__model is-selected"
              type="button"
            >
              <span>
                <strong>DeepSeek V4 Flash</strong>
                <small className="buzz-onboarding-v2__model-meta">
                  Recommended
                </small>
              </span>
              <Check aria-hidden="true" />
            </button>
            <Button
              className="buzz-onboarding-v2__primary"
              onClick={() => patch({ stage: "scout" })}
            >
              Use this model
            </Button>
          </>
        );
      case "scout":
        return (
          <>
            <Heading
              kicker="Step 6 of 7"
              title="Meet Scout, your Chief of Staff"
            >
              Scout is your first and only starting agent. It turns company
              context into coordinated work.
            </Heading>
            <div className="buzz-onboarding-v2__scout">
              <span>
                <AntMark />
              </span>
              <div>
                <strong>Scout</strong>
                <p>Chief of Staff</p>
              </div>
              <i>Ready</i>
            </div>
            <Button
              className="buzz-onboarding-v2__primary"
              onClick={() => patch({ stage: "first-task" })}
            >
              Give Scout a first task
            </Button>
          </>
        );
      case "first-task":
        return (
          <>
            <Heading kicker="Step 7 of 7" title="What should Scout move first?">
              Give Scout one real outcome. It will start in your private Welcome
              channel with the company context you confirmed.
            </Heading>
            <label className="buzz-onboarding-v2__textarea">
              <span>First task</span>
              <textarea
                value={draft.firstTask.content}
                onChange={(event) =>
                  patch({
                    firstTask: {
                      ...draft.firstTask,
                      content: event.target.value,
                    },
                  })
                }
                placeholder="Example: Review our launch plan and tell me the three biggest risks."
              />
            </label>
            {error || externalError ? (
              <ErrorNotice>{error ?? externalError}</ErrorNotice>
            ) : null}
            <Button
              className="buzz-onboarding-v2__primary"
              disabled={!draft.firstTask.content.trim() || isFinalizing}
              onClick={() =>
                void onReadyToFinalize().catch((cause) =>
                  setError(
                    cause instanceof Error
                      ? cause.message
                      : "Scout could not come online.",
                  ),
                )
              }
            >
              {isFinalizing ? "Bringing Scout online…" : "Start my company"}
            </Button>
          </>
        );
      case "entering":
        return (
          <>
            <Heading
              kicker="Your living company"
              title="Scout is taking it from here"
            >
              Your context and first task are moving into the private Welcome
              channel now.
            </Heading>
            <OnboardingV2Status
              label="Opening your workspace"
              detail="The company is online."
            />
          </>
        );
    }
  })();

  const previousStage =
    draft.stage === "website"
      ? "founder"
      : draft.stage === "summary" || draft.stage === "description"
        ? "website"
        : draft.stage === "scout"
          ? draft.runtime.route === "cli"
            ? "runtime-ready"
            : "model"
          : draft.stage === "first-task"
            ? "scout"
            : null;

  return (
    <OnboardingV2Shell stage={draft.stage}>
      {previousStage ? (
        <button
          aria-label="Go back"
          className="buzz-onboarding-v2__back"
          onClick={() => patch({ stage: previousStage })}
          type="button"
        >
          <ChevronLeft aria-hidden="true" />
        </button>
      ) : null}
      {content}
    </OnboardingV2Shell>
  );
}
