import { EP06 } from "./ep06.ts";
import { EP06_SHELL } from "./Explainer06";
import { PinnedCursor } from "./phoneKit";
import { SitePhone } from "./SitePhone";
import { TallShell } from "./TallShell";

/** Explainer 6, "Keeps your website fresh", for Mo's Auto Repairs, on the Reels frame: the site in a phone. */
export const Explainer06Tall: React.FC = () => (
  <TallShell config={EP06_SHELL} compactAt={EP06.siteIn - 0.6}>
    {(t) => (
      <>
        <SitePhone t={t} />
        <PinnedCursor t={t} timing={EP06} />
      </>
    )}
  </TallShell>
);
