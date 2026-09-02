import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
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

/**
 * Whether the stage has content below its bottom edge right now.
 *
 * Re-measured on scroll and whenever the stage or the screen inside it changes
 * size, because both are how "there is more below" starts and stops being
 * true: a window resize, a validation note appearing, a list of detected tools
 * arriving. Re-armed per step, since each screen is a different element.
 */
function useHasContentBelow(
  stageRef: RefObject<HTMLDivElement | null>,
  step: OnboardingStep,
): boolean {
  const [hasContentBelow, setHasContentBelow] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: step is intentional - each screen is a different element inside the stage, so the child observations have to be re-armed on it even though the effect body never reads it
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const measure = () => {
      setHasContentBelow(
        stage.scrollTop + stage.clientHeight < stage.scrollHeight - 1,
      );
    };
    measure();
    stage.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    for (const child of Array.from(stage.children)) observer.observe(child);
    return () => {
      stage.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [stageRef, step]);

  return hasContentBelow;
}

export function OnboardingCanvas({ step, track, children }: Props) {
  const theme = canvasFor(step, track);
  const index = ONBOARDING_STEPS.indexOf(step);
  const stageRef = useRef<HTMLDivElement>(null);
  const hasContentBelow = useHasContentBelow(stageRef, step);

  return (
    <div
      className={`onb-canvas ${theme.ink === "light" ? "dark" : ""}`}
      data-ink={theme.ink}
      style={
        {
          background: theme.base,
          // Exposed as a variable as well as painted, so chrome that has to
          // blend into the canvas (the scroll fade) can reach the hue without
          // a second copy of the table in CSS.
          "--onb-base": theme.base,
          // Derived per hue in canvasTheme.ts, not a fixed value: the flow's
          // one lilac was muddy rose on amber and barely there on pink.
          "--onb-disabled-bg": theme.disabledBg,
          "--onb-disabled-ink": theme.disabledInk,
        } as CSSProperties
      }
    >
      <div className="onb-grain" />
      <AntScatter hue={theme.hue} />
      <p className="onb-step">
        {String(index + 1).padStart(2, "0")} / {ONBOARDING_STEPS.length}
      </p>
      <div className="onb-stage" ref={stageRef}>
        {children}
      </div>
      {hasContentBelow ? (
        <div className="onb-fade" data-testid="onboarding-canvas-scroll-fade" />
      ) : null}
    </div>
  );
}
