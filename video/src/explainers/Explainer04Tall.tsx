import { EP04 } from "./ep04.ts";
import { EP04_SHELL } from "./Explainer04";
import { PinnedCursor } from "./phoneKit";
import { SalesPhone } from "./SalesPhone";
import { TallShell } from "./TallShell";

/** Explainer 4, "Sells for you", for Golden Hour Photography, on the Reels frame. */
export const Explainer04Tall: React.FC = () => (
  <TallShell config={EP04_SHELL} compactAt={EP04.cardIn - 0.6}>
    {(t) => (
      <>
        <SalesPhone t={t} />
        <PinnedCursor t={t} timing={EP04} />
      </>
    )}
  </TallShell>
);
