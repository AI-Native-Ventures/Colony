import { EP02 } from "./ep02.ts";
import { EP02_SHELL } from "./Explainer02";
import { PinnedCursor } from "./phoneKit";
import { ReadCursor, TeamPhone } from "./TeamPhone";
import { TallShell } from "./TallShell";

/** Explainer 2, "Your team in a minute", for Studio Nala, on the Reels frame. */
export const Explainer02Tall: React.FC = () => (
  <TallShell config={EP02_SHELL} compactAt={EP02.cardIn - 0.6}>
    {(t) => (
      <>
        <TeamPhone t={t} />
        <ReadCursor t={t} />
        <PinnedCursor
          t={t}
          timing={{ cursorFrom: EP02.yesCursorFrom, click: EP02.click }}
        />
      </>
    )}
  </TallShell>
);
