// desktop/src/features/onboarding/ui/new/AntScatter.tsx
import { useMemo } from "react";

import { HUE_SCATTER_TONES, type HueName } from "./canvasTheme";
import { WalkingAnt } from "./WalkingAnt";

export type ScatterAnt = {
  /** Stable identity, so React never reuses a wrapper mid-drift. */
  id: string;
  left: number;
  top: number;
  size: number;
  opacity: number;
  /** Index into the screen hue's tonal scatter palette. */
  tone: number;
  driftDelay: number;
  driftDuration: number;
  gaitDelay: number;
};

/**
 * Lay out one colony.
 *
 * Exported for tests, and deterministic given `random`, because the property
 * that matters is not where any single ant sits but that no two share a gait
 * phase. A field whose ants all step together reads as repeating wallpaper
 * rather than as life, and that is the whole reason this exists.
 */
export function layOutScatter(
  count: number,
  random: () => number = Math.random,
): ScatterAnt[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ant-${index}`,
    left: random() * 100,
    top: random() * 100,
    size: 1.5 + random() * 1.5,
    opacity: 0.22 + random() * 0.26,
    tone: index % 4,
    // Negative delays start each ant mid-cycle, so the field is already in
    // motion on the first frame instead of visibly starting together.
    driftDelay: -random() * 26,
    driftDuration: 20 + random() * 16,
    gaitDelay: -random() * 0.42,
  }));
}

/**
 * A colony going about its business behind the flow.
 *
 * Every ant is a `WalkingAnt` inside a wrapper that carries the drift. The
 * wrapper is what animates: WebKit paints SVG children on the main thread, so
 * transforming the mark itself would stutter whenever the thread is busy,
 * which during onboarding it frequently is.
 *
 * Reduced motion is handled in CSS, where both the drift and the gait fall
 * back to a static stance rather than being removed. A still colony is still
 * a colony.
 */
export function AntScatter({
  hue,
  count = 26,
}: {
  hue: HueName;
  count?: number;
}) {
  const tones = HUE_SCATTER_TONES[hue];
  const ants = useMemo(() => layOutScatter(count), [count]);

  return (
    <div className="onb-scatter" aria-hidden="true">
      {ants.map((ant) => (
        <div
          key={ant.id}
          className="onb-scatter__ant"
          style={{
            left: `${ant.left}%`,
            top: `${ant.top}%`,
            width: `${ant.size}rem`,
            opacity: ant.opacity,
            color: tones[ant.tone],
            animationDelay: `${ant.driftDelay}s`,
            animationDuration: `${ant.driftDuration}s`,
            // Consumed by the gait rules in onboarding-canvas.css so each
            // ant steps out of phase with its neighbours.
            ["--onb-gait-delay" as string]: `${ant.gaitDelay}s`,
          }}
        >
          <WalkingAnt />
        </div>
      ))}
    </div>
  );
}
