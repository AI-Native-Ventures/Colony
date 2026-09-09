import type { ReactNode } from "react";
import { FileText, PencilLine } from "lucide-react";
import { AntMark } from "@/shared/ui/colony-logo/AntMark";

type FounderStep = "account" | "recovery" | "company" | "power";

/** The approved founder composition, shared by both account entry paths. */
export function FounderLayout({
  step,
  children,
  onSignIn,
  navigationDisabled = false,
  business,
  description,
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
        <img
          src="/landing/colony-wordmark.svg"
          alt="Colony"
          className="onb-simple-wordmark"
        />
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
          {[
            "top-left",
            "top-inner",
            "middle-high",
            "middle-low",
            "bottom-left",
            "bottom-inner",
            "top-right",
            "bottom-right",
          ].map((position) => (
            <span className="onb-founder-ant" key={position}>
              <AntMark />
            </span>
          ))}
        </div>
        <div className="onb-founder-story">
          <div
            className="onb-founder-steps"
            data-testid="onboarding-step-counter"
          >
            {!businessOnly && (
              <>
                <span
                  aria-current={
                    step === "account" || step === "recovery"
                      ? "step"
                      : undefined
                  }
                >
                  1 · Account
                </span>
                <span className="onb-founder-step-divider" />
              </>
            )}
            <span aria-current={company ? "step" : undefined}>
              {businessOnly ? "1" : "2"} · Business
            </span>
            <span className="onb-founder-step-divider" />
            <span aria-current={step === "power" ? "step" : undefined}>
              {businessOnly ? "2" : "3"} · Power
            </span>
          </div>
          <header className="onb-simple-heading">
            <h1>
              {step === "power" ? (
                <>
                  Your team.
                  <br />
                  Your choice.
                </>
              ) : company ? (
                <>
                  Make this
                  <br />
                  your Colony.
                </>
              ) : step === "recovery" ? (
                <>
                  Your account.
                  <br />
                  One safe way back.
                </>
              ) : (
                <>
                  A little help.
                  <br />A lot off your plate.
                </>
              )}
            </h1>
            <p>
              {step === "power"
                ? "Use a subscription, Colony Credits, or OpenRouter free models. You choose what powers your teammates."
                : company
                  ? "A name and a little context help your teammate get the details right."
                  : step === "recovery"
                    ? "A quick safeguard before we set up your business."
                    : "Give your AI teammate a job. Get work back that you can review and make your own."}
            </p>
          </header>
          <aside className="onb-founder-example">
            <p className="onb-founder-example-caption">
              {company
                ? "The context your teammate starts with"
                : "A first job could look like this"}
            </p>
            <div className="onb-founder-person">
              <span
                className={
                  company ? "onb-founder-business-icon" : "onb-founder-avatar"
                }
              >
                {company
                  ? business
                      ?.trim()
                      .split(/\s+/)
                      .map((part) => part[0])
                      .slice(0, 2)
                      .join("")
                      .toUpperCase() || "B"
                  : "S"}
              </span>
              <div>
                <p className="onb-founder-person-name">
                  {company ? business?.trim() || "Your business" : "Scout"}
                </p>
                {!company && (
                  <p className="onb-founder-person-role">Your first teammate</p>
                )}
              </div>
            </div>
            <p className="onb-founder-example-title">
              {company
                ? description?.trim() ||
                  "Your website or description will give Scout a starting point."
                : "Turn your offer into a week of Instagram content."}
            </p>
            <p className="onb-founder-example-output">
              {company ? <PencilLine /> : <FileText />}
              {company
                ? "You can update this any time"
                : "Five captions + visual briefs to review"}
            </p>
          </aside>
        </div>
        {children}
      </div>
      <footer className="onb-founder-footer">
        <span>Your business, with a little more help.</span>
        <AntMark />
      </footer>
    </section>
  );
}
