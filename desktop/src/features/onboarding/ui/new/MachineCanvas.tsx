// desktop/src/features/onboarding/ui/new/MachineCanvas.tsx
import { useRef, type CSSProperties, type ReactNode } from "react";
import { useHasContentBelow } from "./OnboardingCanvas";

import { AntScatter } from "./AntScatter";
import {
  MACHINE_STEPS,
  machineCanvasFor,
  type MachineStep,
} from "./machineSteps";
import "./onboarding-canvas.css";
import "./onboarding-screens.css";
import "./onboarding-founder.css";

type Props = {
  step: MachineStep;
  /**
   * The landing screen wears the canvas without the step marker: it is the
   * first thing anyone sees of Colony, and a progress count on it announces
   * a chore before the product has said what it is.
   */
  showStep?: boolean;
  /**
   * Which gate this is, for the specs that wait on one. Defaults to machine
   * onboarding because that is what wore the canvas first; screens that are
   * not machine setup name themselves, so a spec asserting the machine flow
   * has gone does not match a later screen wearing the same canvas.
   */
  testId?: string;
  /** For a canvas that covers another one, which needs to stack above it. */
  className?: string;
  /** Merged over the hue, for a canvas that fades itself out. */
  style?: CSSProperties;
  children: ReactNode;
};

export function MachineCanvas({
  step,
  showStep = true,
  testId = "machine-onboarding-gate",
  className,
  style,
  children,
}: Props) {
  const theme = machineCanvasFor(step);
  const stageRef = useRef<HTMLDivElement>(null);
  const hasContentBelow = useHasContentBelow(
    stageRef,
    step === "backup" ? "recovery" : "account",
  );
  const index = MACHINE_STEPS.indexOf(step);

  return (
    <div
      className={className ? `onb-canvas ${className}` : "onb-canvas"}
      data-ink={theme.ink}
      data-testid={testId}
      style={{ background: theme.base, ...style }}
    >
      <div className="onb-grain" />
      {className === "onb-founder-canvas" && (
        <img
          src="/landing/colony-wordmark.svg"
          alt="Colony"
          className="onb-simple-wordmark"
        />
      )}
      <AntScatter hue={theme.hue} />
      {/* Both numbers are padded. The marker is a mono chapter mark, and
          "01 / 2" reads as a typo beside the flow's own "01 / 10". */}
      {showStep ? (
        <p className="onb-step">
          {String(index + 1).padStart(2, "0")} /{" "}
          {String(MACHINE_STEPS.length).padStart(2, "0")}
        </p>
      ) : null}
      <div className="onb-stage" ref={stageRef}>
        {children}
      </div>
      {hasContentBelow && (
        <div className="onb-fade" data-testid="onboarding-canvas-scroll-fade" />
      )}
    </div>
  );
}
