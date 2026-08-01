// desktop/src/shared/ui/colony-logo/FuzzyMark.tsx
import ColonyLogoAnimation from "./ColonyLogoAnimation";

export type FuzzyMarkProps = {
  /** When false, skips the looping feTurbulence texture and uses a CSS pulse instead. */
  fuzz?: boolean;
  className?: string;
  ariaLabel?: string;
  loop?: boolean;
  /** When looping, hide the mark for this many seconds between plays. */
  loopRestSeconds?: number;
  /** Set false when a parent drives its own opacity animation over the mark. */
  pulse?: boolean;
};

/**
 * The fuzzy Colony mark. Set `fuzz={false}` to render the crisp geometry with
 * a lightweight CSS pulse, recommended for long-lived mounts.
 */
export function FuzzyMark({
  fuzz = true,
  className,
  ariaLabel = "Colony logo",
  loop = false,
  loopRestSeconds = 0,
  pulse = true,
}: FuzzyMarkProps) {
  const hasRestWindow = loop && loopRestSeconds > 0;

  return (
    <ColonyLogoAnimation
      ariaLabel={ariaLabel}
      className={className}
      loop={loop}
      loopRestSeconds={loopRestSeconds}
      pulse={pulse && !fuzz && !hasRestWindow}
      textured={fuzz}
    />
  );
}
