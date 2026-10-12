import { EP01 } from "./ep01.ts";
import { EP01_SHELL } from "./Explainer01";
import { PinnedCursor } from "./phoneKit";
import { PlanPhone } from "./PlanPhone";
import { TallShell } from "./TallShell";

/** Explainer 1, "Meet Scout", for Mahlangu Builders, on the Reels frame: the plan as a phone. */
export const Explainer01Tall: React.FC = () => (
  <TallShell config={EP01_SHELL} compactAt={EP01.cardIn - 0.6}>
    {(t) => (
      <>
        <PlanPhone t={t} />
        <PinnedCursor t={t} timing={EP01} />
      </>
    )}
  </TallShell>
);
