// desktop/src/shared/ui/colony-logo/ColonyLogoAnimation.tsx
import { useEffect, useId, useState } from "react";
import type { CSSProperties } from "react";

import { cn } from "@/shared/lib/cn";
import { AntMark } from "./AntMark";
import "./colony-logo-animation.css";

export type ColonyLogoAnimationProps = {
  ariaLabel?: string;
  className?: string;
  /** Apply the animated fractal-noise grain filter. */
  textured?: boolean;
  /** Loop with a rest window (mark hides briefly between plays). */
  loop?: boolean;
  loopRestSeconds?: number;
  pulse?: boolean;
};

/**
 * Tracks `prefers-reduced-motion`. CSS `animation: none` only stops CSS
 * animations, not the SMIL `<animate>` driving the grain filter's seed below,
 * so that timeline is suppressed here instead.
 */
function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncReducedMotion = () => setPrefersReducedMotion(mediaQuery.matches);

    syncReducedMotion();
    mediaQuery.addEventListener("change", syncReducedMotion);
    return () => mediaQuery.removeEventListener("change", syncReducedMotion);
  }, []);

  return prefersReducedMotion;
}

/**
 * Colony's animated mark engine. Replaces the Buzz morph engine with a much
 * smaller composition: the static AntMark, an optional feTurbulence grain
 * texture, and CSS-driven pulse / rest-window loops. Opacity animation is
 * CSS-only and already stops under reduced motion; the grain filter's SMIL
 * seed animation is skipped entirely in that case so every mode falls back to
 * a static frame.
 *
 * AntMark's own `<svg>` is rendered as the only direct child of the labeled
 * wrapper (not nested inside another span) so consumer classes that target
 * `[&>svg]` (e.g. the App boot overlay forcing the mark to fill its
 * container) land on the actual mark.
 */
export default function ColonyLogoAnimation({
  ariaLabel = "Colony logo",
  className,
  textured = false,
  loop = false,
  loopRestSeconds = 0,
  pulse = false,
}: ColonyLogoAnimationProps) {
  const filterId = `colony-fuzz-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const prefersReducedMotion = usePrefersReducedMotion();
  const hasRestWindow = loop && loopRestSeconds > 0;
  const loopDuration = 3 + loopRestSeconds;

  const style = {
    ...(hasRestWindow && {
      "--colony-loop-duration": `${loopDuration}s`,
    }),
    ...(textured && {
      "--colony-filter": `url(#${filterId})`,
    }),
  } as CSSProperties;
  const hasStyle = hasRestWindow || textured;

  return (
    <span
      aria-label={ariaLabel}
      className={cn(
        "colony-logo",
        pulse && "colony-logo--pulse",
        hasRestWindow && "colony-logo--rest-loop",
        className,
      )}
      role="img"
      style={hasStyle ? style : undefined}
    >
      {textured && (
        // Visually hidden via the standard sr-only clip pattern rather than
        // zero-sized (h-0 w-0): a zero-size ancestor stops Chromium from
        // running the SMIL <animate> below, since it never activates a
        // render tree it treats as having no box to paint.
        <span aria-hidden="true" className="sr-only">
          <svg aria-hidden="true">
            <defs>
              <filter id={filterId}>
                <feTurbulence
                  baseFrequency="0.9"
                  numOctaves="2"
                  result="noise"
                  seed="1"
                  type="fractalNoise"
                >
                  {!prefersReducedMotion && (
                    <animate
                      attributeName="seed"
                      dur="0.6s"
                      repeatCount="indefinite"
                      values="1;2;3;4;5;1"
                    />
                  )}
                </feTurbulence>
                <feDisplacementMap in="SourceGraphic" in2="noise" scale="6" />
              </filter>
            </defs>
          </svg>
        </span>
      )}
      <AntMark
        className={cn(
          "colony-logo__mark",
          textured && "colony-logo__mark--textured",
        )}
      />
    </span>
  );
}
