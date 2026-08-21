import type { ReactNode } from "react";
import type { OnboardingStep, OnboardingTrack } from "../../flow/steps";
import { ONBOARDING_STEPS } from "../../flow/steps";
import { canvasFor } from "./canvasTheme";
import "./onboarding-canvas.css";

type Props = {
  step: OnboardingStep;
  track: OnboardingTrack;
  children: ReactNode;
};

export function OnboardingCanvas({ step, track, children }: Props) {
  const theme = canvasFor(step, track);
  const index = ONBOARDING_STEPS.indexOf(step);
  const mesh = theme.mesh
    .map(
      (b) =>
        `radial-gradient(circle at ${b.x} ${b.y}, ${b.color} 0%, transparent ${b.radius})`,
    )
    .join(",");

  return (
    <div
      className={`onb-canvas ${theme.ink === "light" ? "dark" : ""}`}
      data-ink={theme.ink}
      style={{ background: theme.base }}
    >
      <div className="onb-mesh" style={{ background: mesh }} />
      <div className="onb-streak" />
      <div className="onb-grain" />
      <p className="onb-step">
        {String(index + 1).padStart(2, "0")} / {ONBOARDING_STEPS.length}
      </p>
      <div className="onb-stage">{children}</div>
    </div>
  );
}
