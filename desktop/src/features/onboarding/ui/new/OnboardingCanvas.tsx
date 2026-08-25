import type { ReactNode } from "react";
import type { OnboardingStep, OnboardingTrack } from "../../flow/steps";
import { ONBOARDING_STEPS } from "../../flow/steps";
import { AntScatter } from "./AntScatter";
import { canvasFor } from "./canvasTheme";
import "./onboarding-canvas.css";
import "./onboarding-screens.css";

type Props = {
  step: OnboardingStep;
  track: OnboardingTrack;
  children: ReactNode;
};

export function OnboardingCanvas({ step, track, children }: Props) {
  const theme = canvasFor(step, track);
  const index = ONBOARDING_STEPS.indexOf(step);

  return (
    <div
      className={`onb-canvas ${theme.ink === "light" ? "dark" : ""}`}
      data-ink={theme.ink}
      style={{ background: theme.base }}
    >
      <div className="onb-grain" />
      <AntScatter hue={theme.hue} />
      <p className="onb-step">
        {String(index + 1).padStart(2, "0")} / {ONBOARDING_STEPS.length}
      </p>
      <div className="onb-stage">{children}</div>
    </div>
  );
}
