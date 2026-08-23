// desktop/src/features/onboarding/ui/new/MachineCanvas.tsx
import type { ReactNode } from "react";

import { AntScatter } from "./AntScatter";
import {
  MACHINE_STEPS,
  machineCanvasFor,
  type MachineStep,
} from "./machineSteps";
import "./onboarding-canvas.css";
import "./onboarding-screens.css";

type Props = {
  step: MachineStep;
  /**
   * The landing screen wears the canvas without the step marker: it is the
   * first thing anyone sees of Colony, and a progress count on it announces
   * a chore before the product has said what it is.
   */
  showStep?: boolean;
  children: ReactNode;
};

export function MachineCanvas({ step, showStep = true, children }: Props) {
  const theme = machineCanvasFor(step);
  const index = MACHINE_STEPS.indexOf(step);

  return (
    <div
      className="onb-canvas"
      data-ink={theme.ink}
      data-testid="machine-onboarding-gate"
      style={{ background: theme.base }}
    >
      <div className="onb-grain" />
      <AntScatter hue={theme.hue} />
      {showStep ? (
        <p className="onb-step">
          {String(index + 1).padStart(2, "0")} / {MACHINE_STEPS.length}
        </p>
      ) : null}
      <div className="onb-stage">{children}</div>
    </div>
  );
}
