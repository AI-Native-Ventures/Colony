import type { ReactNode } from "react";
import { AntMark } from "@/shared/ui/colony-logo/AntMark";

type FounderStep = "account" | "recovery" | "company" | "power" | "history";

/** The approved founder composition, shared by both account entry paths. */
export function FounderLayout({
  step,
  children,
  onSignIn,
  navigationDisabled = false,
  businessOnly = false,
}: {
  step: FounderStep;
  children: ReactNode;
  onSignIn?: () => void;
  navigationDisabled?: boolean;
  business?: string;
  description?: string;
  businessOnly?: boolean;
}) {
  const company = step === "company";
  return (
    <section
      className="onb-simple"
      data-testid={`onboarding-${company ? "business" : step}`}
      data-founder-step={step}
    >
      <header className="onb-founder-chrome">
        <div className="onb-brand">
          <AntMark />
          <img
            src="/landing/colony-wordmark.svg"
            alt="Colony"
            className="onb-simple-wordmark"
          />
        </div>
        {onSignIn && (
          <div className="onb-founder-chrome-end">
            <span>Already have an account?</span>
            <button
              className="onb-simple-link"
              type="button"
              onClick={onSignIn}
              disabled={navigationDisabled}
            >
              Sign in
            </button>
          </div>
        )}
      </header>
      <div className="onb-founder-intro">
        <div className="onb-founder-ants" aria-hidden="true">
          {["top-left", "bottom-left", "top-right", "bottom-right"].map(
            (position) => (
              <span className="onb-founder-ant" key={position}>
                <AntMark />
              </span>
            ),
          )}
        </div>
        <nav className="onb-founder-story" aria-label="Setup progress">
          <ol className="onb-progress" data-testid="onboarding-step-counter">
            {(businessOnly
              ? ["Business", "Connect and test", "Get to know you"]
              : ["Account", "Business", "Connect and test", "Get to know you"]
            ).map((label, index) => {
              const active =
                (step === "account" || step === "recovery"
                  ? 0
                  : step === "company"
                    ? 1
                    : step === "power"
                      ? 2
                      : 3) - (businessOnly ? 1 : 0);
              return (
                <li
                  key={label}
                  aria-current={index === active ? "step" : undefined}
                  data-complete={index < active}
                >
                  <span className="onb-progress-number">
                    {index < active ? "✓" : index + 1}
                  </span>
                  <span>{label}</span>
                </li>
              );
            })}
          </ol>
        </nav>
        {children}
      </div>
    </section>
  );
}
