import { OWNER } from "../launch/wide/employees.ts";
import { EP07 } from "./ep07.ts";
import { EP07_SHELL } from "./Explainer07";
import { PinnedCursor } from "./phoneKit";
import { PhonePlane, ReviewPhone } from "./ReviewPhone";
import { TallShell } from "./TallShell";

/** Explainer 7, "Nothing goes out without your yes", for Sparkle Cleaning, on the Reels frame. */
export const Explainer07Tall: React.FC = () => (
  <TallShell config={EP07_SHELL} compactAt={EP07.cardIn - 0.6}>
    {(t) => (
      <>
        <ReviewPhone t={t} tone={OWNER} />
        <PinnedCursor t={t} timing={EP07} />
        <PhonePlane t={t} at={EP07.sentAt} color={OWNER.color} />
      </>
    )}
  </TallShell>
);
