import { TallHero } from "../launch/tall/TallHero";
import { LOOKS } from "../launch/wide/employees.ts";
import { EP03 } from "./ep03.ts";
import { EP03_SHELL } from "./Explainer03";
import { LeadsPhone, RestCursor, TickCursor } from "./LeadsPhone";
import { TallShell } from "./TallShell";

/** Explainer 3, "Finds customers", for Bright Plumbing, on the Reels frame: the leads, then the hand-over to sales. */
export const Explainer03Tall: React.FC = () => (
  <TallShell config={EP03_SHELL} compactAt={EP03.boardIn - 0.6}>
    {(t) => (
      <>
        <LeadsPhone t={t} />
        <TallHero
          t={t}
          look={LOOKS.amber}
          timing={{
            avatarAt: EP03.amberAvatarAt,
            headlineAt: EP03.amberHeadlineAt,
            sublineAt: EP03.amberSublineAt,
          }}
          compactAt={EP03.amberAvatarAt - 0.7}
        />
        <TickCursor t={t} />
        <RestCursor t={t} />
      </>
    )}
  </TallShell>
);
