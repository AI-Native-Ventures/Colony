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
  type FounderGender,
  type OnboardingV2Draft,
  type OnboardingV2Journey,
} from "@/features/onboarding/onboardingV2";
import {
  buildEditableCompanySummary,
  scanOnboardingCompanyWebsite,
} from "@/shared/api/tauriCompanyScan";
import {
  getGlobalAgentConfig,
  setGlobalAgentConfig,
} from "@/shared/api/tauriGlobalAgentConfig";
import {
  getColonyCreditsAccount,
  getColonyCreditsStatus,
} from "@/shared/api/tauriProvisionedCredits";
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
    <div>
      <span className="mb-3.5 block text-xs font-bold uppercase tracking-[0.12em] text-primary">
        {kicker}
      </span>
      <h1 className="m-0 max-w-full text-2xl font-semibold leading-tight tracking-tight">
        {title}
      </h1>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

function ErrorNotice({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 text-sm text-destructive" role="alert">
      {children}
    </p>
  );
}

export function OnboardingV2Flow({
  draft,
  journey = "first-community",
  onChange,
  onReadyToFinalize,
  onSkip,
  externalError,
  isFinalizing = false,
}: {
  draft: OnboardingV2Draft;
  journey?: OnboardingV2Journey;
  onChange: (draft: OnboardingV2Draft) => void;
  onReadyToFinalize: () => Promise<void>;
  onSkip?: () => void;
  externalError?: string;
  isFinalizing?: boolean;
}) {
  const isAdditionalCommunity = journey === "additional-community";
  const runtimes = useAcpRuntimesQuery({
    enabled: draft.stage === "company" || draft.stage === "scout-task",
  });
  const installRuntime = useInstallAcpRuntimeMutation();
  const [error, setError] = React.useState<string | null>(null);
  const scanGeneration = React.useRef(0);
  const autoFilledSummary = React.useRef(false);

  // Async callbacks (scan, runtime configure) must never write a stale draft
  // over edits the user made while they were in flight.
  const draftRef = React.useRef(draft);
  draftRef.current = draft;

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

  const runScan = React.useCallback(async () => {
    const current = draftRef.current;
    const url = current.company.website.trim();
    if (!isValidBusinessWebsite(url)) return;
    const generation = ++scanGeneration.current;
    setError(null);
    onChange({
      ...current,
      company: { ...current.company, scanStatus: "running" },
    });
    try {
      const result = await scanOnboardingCompanyWebsite(url);
      if (scanGeneration.current !== generation) return;
      const latest = draftRef.current;
      if (result.status === "success") {
        const summaryIsEmptyOrOurs =
          latest.company.summary.trim().length === 0 ||
          autoFilledSummary.current;
        const summary = summaryIsEmptyOrOurs
          ? buildEditableCompanySummary(result.result)
          : latest.company.summary;
        autoFilledSummary.current = true;
        onChange({
          ...latest,
          company: {
            ...latest.company,
            canonicalUrl: result.result.canonicalUrl,
            summary,
            scanStatus: "success",
          },
        });
        return;
      }
      onChange({
        ...latest,
        company: {
          ...latest.company,
          scanStatus: result.status === "timeout" ? "timeout" : "failed",
        },
      });
    } catch (cause) {
      if (scanGeneration.current !== generation) return;
      setError(
        cause instanceof Error ? cause.message : "The scan could not finish.",
      );
      onChange({
        ...draftRef.current,
        company: { ...draftRef.current.company, scanStatus: "failed" },
      });
    }
  }, [onChange]);

  // Runtime detection starts on the company screen so it is already resolved
  // (or installing) by the time the user reaches Scout. Every journey gets
  // it — created companies previously skipped setup entirely.
  React.useEffect(() => {
    if (draft.runtime.route !== null) return;
    if (runtimes.isPending || !runtimes.data) return;
    let cancelled = false;
    const configure = async () => {
      setError(null);
      const choice = selectAutomaticRuntime(runtimes.data);
      try {
        if (choice.route === "cli") {
          const current = await getGlobalAgentConfig();
          await setGlobalAgentConfig(
            configForAutomaticCli(current, choice.runtimeId),
          );
        }
        if (!cancelled) {
          onChange({
            ...draftRef.current,
            runtime: {
              ...draftRef.current.runtime,
              route: choice.route,
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
  }, [draft.runtime.route, onChange, runtimes.data, runtimes.isPending]);

  const continueFromCompany = () => {
    setError(null);
    patch({ stage: "scout-task" });
  };

  const saveFounder = async () => {
    if (!founderDetailsAreValid(draft.founder)) return;
    setError(null);
    try {
      await updateProfile({ displayName: draft.founder.fullName.trim() });
      patch({ stage: "company" });
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
      let credits: OnboardingV2Draft["credits"] = {
        balanceNanousd: null,
        status: "unavailable",
      };
      try {
        const account = await getColonyCreditsAccount();
        credits = {
          balanceNanousd: account.balance_nanousd,
          status: getColonyCreditsStatus(account.balance_nanousd),
        };
      } catch {
        // Account visibility never blocks entry. The relay remains the
        // authority that prevents model work without usable credits.
      }
      patch({ credits });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Colony Agent could not be installed.",
      );
    }
  };

  const scanChip = (() => {
    switch (draft.company.scanStatus) {
      case "running":
        return (
          <p
            className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary/25 border-t-primary motion-reduce:animate-none"
            />
            Reading your website in the background. You can keep typing.
          </p>
        );
      case "success":
        return (
          <p className="mt-2.5 text-xs text-muted-foreground" role="status">
            Summary started from your website. Edit anything it got wrong.
          </p>
        );
      case "failed":
      case "timeout":
        return (
          <div className="mt-2.5 flex items-center gap-3">
            <p className="text-xs text-destructive" role="alert">
              {draft.company.scanStatus === "timeout"
                ? "The scan ended before it had a reliable answer."
                : "The scan could not read that website."}
            </p>
            <button
              className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              onClick={() => void runScan()}
              type="button"
            >
              Try again
            </button>
          </div>
        );
      default:
        return null;
    }
  })();

  const content = (() => {
    switch (draft.stage) {
      case "founder":
        return (
          <>
            <Heading kicker="Step 1 of 4" title="Let’s start with you">
              A few human details help Scout understand who it is working with.
            </Heading>
            <div className="mt-6 grid grid-cols-2 gap-4.5">
              <label
                className="col-span-full"
                htmlFor="onboarding-founder-name"
              >
                <span className="mb-2 block pl-1 text-xs font-semibold">
                  Full name
                </span>
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
                <span className="mb-2 block pl-1 text-xs font-semibold">
                  Country
                </span>
                <select
                  className="h-11 w-full rounded-xl border border-border/70 bg-background/80 px-3 text-sm outline-hidden focus-visible:border-primary/70 focus-visible:ring-2 focus-visible:ring-primary/15"
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
                <span className="mb-2 block pl-1 text-xs font-semibold">
                  City
                </span>
                <Input
                  id="onboarding-founder-city"
                  value={draft.founder.city}
                  onChange={(event) =>
                    patchFounder({ city: event.target.value })
                  }
                  placeholder="Your city"
                />
              </label>
              <fieldset className="col-span-full border-0 p-0">
                <legend className="mb-2 pl-1 text-xs font-semibold">
                  Gender{" "}
                  <small className="font-normal text-muted-foreground">
                    optional
                  </small>
                </legend>
                <div className="flex flex-wrap gap-2">
                  {GENDER_OPTIONS.map((option) => (
                    <button
                      className={
                        draft.founder.gender === option.value
                          ? "rounded-full border border-primary bg-primary px-3.5 py-2 text-xs text-primary-foreground transition-colors"
                          : "rounded-full border border-border/70 bg-background/60 px-3.5 py-2 text-xs text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
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
                  className="col-span-full"
                  htmlFor="onboarding-founder-gender-description"
                >
                  <span className="mb-2 block pl-1 text-xs font-semibold">
                    How should we describe you?
                  </span>
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
              className="mt-6 h-11 rounded-full px-6"
              disabled={!founderDetailsAreValid(draft.founder)}
              onClick={() => void saveFounder()}
            >
              Continue
            </Button>
          </>
        );
      case "company":
        return (
          <>
            <Heading
              kicker={isAdditionalCommunity ? "Step 1 of 3" : "Step 2 of 4"}
              title="Show Colony the business"
            >
              Add a website and Colony reads it in the background while you keep
              moving. A sentence of your own works too.
            </Heading>
            <label className="mt-7 block" htmlFor="onboarding-business-website">
              <span className="mb-2 block pl-1 text-xs font-semibold">
                Business website{" "}
                <small className="font-normal text-muted-foreground">
                  optional
                </small>
              </span>
              <div className="relative">
                <Globe2
                  aria-hidden="true"
                  className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  autoFocus
                  className="pl-11"
                  id="onboarding-business-website"
                  value={draft.company.website}
                  onChange={(event) =>
                    patchCompany({ website: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      isValidBusinessWebsite(draft.company.website) &&
                      draft.company.scanStatus === "idle"
                    ) {
                      event.preventDefault();
                      void runScan();
                    }
                  }}
                  placeholder="https://yourcompany.com"
                />
              </div>
            </label>
            {draft.company.scanStatus === "idle" &&
            isValidBusinessWebsite(draft.company.website) ? (
              <button
                className="mt-2.5 self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                onClick={() => void runScan()}
                type="button"
              >
                Read my website
              </button>
            ) : null}
            {scanChip}
            <label className="mt-6 block" htmlFor="onboarding-business-summary">
              <span className="mb-2 block pl-1 text-xs font-semibold">
                What does the business do?{" "}
                <small className="font-normal text-muted-foreground">
                  optional
                </small>
              </span>
              <textarea
                className="min-h-24 w-full resize-y rounded-2xl border border-border/70 bg-background/80 p-4 text-sm outline-hidden transition-colors placeholder:text-muted-foreground/60 focus-visible:border-primary/70 focus-visible:ring-2 focus-visible:ring-primary/15"
                id="onboarding-business-summary"
                value={draft.company.summary}
                onChange={(event) =>
                  patchCompany({ summary: event.target.value })
                }
                placeholder="What do you sell, who do you serve, and what makes the business distinctive?"
              />
            </label>
            {error ? <ErrorNotice>{error}</ErrorNotice> : null}
            <Button
              className="mt-6 h-11 rounded-full px-6"
              onClick={continueFromCompany}
            >
              Continue
            </Button>
          </>
        );
      case "scout-task":
        return (
          <>
            <Heading
              kicker={isAdditionalCommunity ? "Step 2 of 3" : "Step 3 of 4"}
              title="Meet Scout, your Chief of Staff"
            >
              Scout turns the company context you confirmed into coordinated
              work, starting in your private Welcome channel.
            </Heading>
            <div className="mt-7 flex items-center gap-4 rounded-2xl border border-border/60 bg-background p-5">
              <span className="flex h-13 w-13 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
                <AntMark />
              </span>
              <div>
                <strong className="block text-sm font-semibold">Scout</strong>
                <p className="mt-1 text-xs text-muted-foreground">
                  Chief of Staff
                </p>
              </div>
              <i className="ml-auto text-xs font-medium text-primary not-italic">
                Ready
              </i>
            </div>
            <div className="mt-3 rounded-2xl border border-border/60 bg-background p-5">
              {draft.runtime.route === null ? (
                <div className="flex items-center gap-4" role="status">
                  <span
                    aria-hidden="true"
                    className="h-7 w-7 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary motion-reduce:animate-none"
                  />
                  <div>
                    <strong className="block text-sm font-semibold">
                      Checking this computer
                    </strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Finding the simplest ready way to run your team.
                    </p>
                  </div>
                </div>
              ) : draft.runtime.route === "cli" ? (
                <div className="flex items-center gap-4" role="status">
                  <Check
                    aria-hidden="true"
                    className="h-7 w-7 shrink-0 text-primary"
                  />
                  <div>
                    <strong className="block text-sm font-semibold">
                      {draft.runtime.selectedId} is connected
                    </strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Your existing AI setup runs the team. Nothing to buy.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-4">
                  <Sparkles
                    aria-hidden="true"
                    className="h-7 w-7 shrink-0 text-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <strong className="block text-sm font-semibold">
                      Colony Agent
                    </strong>
                    <p className="mt-1 text-xs text-muted-foreground">
                      The secure managed option. Signed runtime, no technical
                      setup.
                    </p>
                    {error ? <ErrorNotice>{error}</ErrorNotice> : null}
                  </div>
                  <Button
                    className="h-9 shrink-0 rounded-full px-5 text-xs"
                    disabled={installRuntime.isPending}
                    onClick={() => void installColonyAgent()}
                  >
                    {installRuntime.isPending ? "Installing…" : "Install"}
                  </Button>
                </div>
              )}
            </div>
            <div className="mt-3 flex items-center justify-between rounded-2xl border-2 border-primary/60 bg-background p-5">
              <span>
                <strong className="block text-sm font-semibold">
                  DeepSeek V4 Flash
                </strong>
                <small className="mt-1 block text-3xs uppercase tracking-wide text-muted-foreground">
                  Recommended
                </small>
              </span>
              <Check aria-hidden="true" className="h-5 w-5 text-primary" />
            </div>
            {draft.runtime.route === "colony-agent" &&
            draft.credits.status !== "active" ? (
              <div
                className="mt-3 rounded-2xl border border-amber-500/25 bg-amber-100/70 p-4 text-xs leading-relaxed text-amber-800"
                data-testid="onboarding-zero-credits-warning"
                role="status"
              >
                You can enter Colony now. Scout and other agents will not
                respond until you add credits. Your balance is always visible
                beside your profile.
              </div>
            ) : null}
            <label className="mt-6 block" htmlFor="onboarding-first-task">
              <span className="mb-2 block pl-1 text-xs font-semibold">
                First task for Scout{" "}
                <small className="font-normal text-muted-foreground">
                  optional
                </small>
              </span>
              <textarea
                className="min-h-24 w-full resize-y rounded-2xl border border-border/70 bg-background/80 p-4 text-sm outline-hidden transition-colors placeholder:text-muted-foreground/60 focus-visible:border-primary/70 focus-visible:ring-2 focus-visible:ring-primary/15"
                id="onboarding-first-task"
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
              <>
                <ErrorNotice>{error ?? externalError}</ErrorNotice>
                {onSkip ? (
                  <button
                    className="mt-3 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                    data-testid="onboarding-skip-for-now"
                    onClick={onSkip}
                    type="button"
                  >
                    Skip for now and open Colony
                  </button>
                ) : null}
              </>
            ) : null}
            <Button
              className="mt-6 h-11 rounded-full px-6"
              data-testid="onboarding-start-company"
              disabled={isFinalizing}
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
              {isFinalizing
                ? "Bringing Scout online…"
                : isAdditionalCommunity
                  ? "Start this company"
                  : "Start my company"}
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
    draft.stage === "company"
      ? isAdditionalCommunity
        ? null
        : "founder"
      : draft.stage === "scout-task"
        ? "company"
        : null;

  return (
    <OnboardingV2Shell journey={journey} stage={draft.stage}>
      {previousStage ? (
        <button
          aria-label="Go back"
          className="mb-4 flex h-9 w-9 items-center justify-center rounded-full border border-border/60 bg-background/70 text-muted-foreground transition-colors hover:text-foreground"
          disabled={isFinalizing}
          onClick={() => patch({ stage: previousStage })}
          type="button"
        >
          <ChevronLeft aria-hidden="true" className="h-4 w-4" />
        </button>
      ) : null}
      {content}
    </OnboardingV2Shell>
  );
}
