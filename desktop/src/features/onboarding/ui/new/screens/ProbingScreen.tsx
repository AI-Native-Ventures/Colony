// desktop/src/features/onboarding/ui/new/screens/ProbingScreen.tsx
import { useEffect, useState } from "react";
import { useAcpRuntimesQuery } from "@/features/agents/hooks";
import { WalkingAnt } from "../WalkingAnt";
import { PROBE_BUDGET_MS, resolveTrack } from "../../../flow/track";
import type { TrackResult } from "../../../flow/track";
import type { GlobalAgentConfig } from "@/shared/api/types";

export const PROBE_LINES = [
  "Making your workspace",
  "Looking at what is already on your computer",
  "Getting your first agents ready",
];

/** Minimum time on screen, so a fast probe reads as a step and not a flash. */
const MIN_VISIBLE_MS = 2000;

type Props = {
  globalConfig: GlobalAgentConfig;
  reducedMotion: boolean;
  onResolved: (result: TrackResult) => void;
};

export function ProbingScreen({
  globalConfig,
  reducedMotion,
  onResolved,
}: Props) {
  const runtimes = useAcpRuntimesQuery();
  const [line, setLine] = useState(0);

  useEffect(() => {
    if (reducedMotion) return undefined;
    const id = setInterval(
      () => setLine((current) => Math.min(current + 1, PROBE_LINES.length - 1)),
      1150,
    );
    return () => clearInterval(id);
  }, [reducedMotion]);

  useEffect(() => {
    const started = Date.now();
    let cancelled = false;

    const settle = (result: TrackResult) => {
      if (cancelled) return;
      const elapsed = Date.now() - started;
      const hold = Math.max(0, MIN_VISIBLE_MS - elapsed);
      setTimeout(() => {
        if (!cancelled) onResolved(result);
      }, hold);
    };

    // The whole screen is capped. A binary that never answers is treated as
    // absent rather than being allowed to end onboarding.
    const budget = setTimeout(
      () => settle({ track: "colony", installed: [], brains: [] }),
      PROBE_BUDGET_MS,
    );

    if (runtimes.data) {
      clearTimeout(budget);
      settle(resolveTrack(runtimes.data, globalConfig));
    }

    return () => {
      cancelled = true;
      clearTimeout(budget);
    };
  }, [runtimes.data, globalConfig, onResolved]);

  return (
    <div className="onb-screen" data-solo="true">
      <div className="onb-col-head">
        <h1 className="onb-headline">
          Building your <em>workspace</em>.
        </h1>
      </div>
      <div className="onb-search" aria-hidden="true">
        <WalkingAnt className="onb-search-ant" />
      </div>
      <p className="onb-status" aria-live="polite">
        {PROBE_LINES[line]}
      </p>
    </div>
  );
}
