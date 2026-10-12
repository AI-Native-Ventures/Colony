import { ChatPhone } from "./ChatPhone";
import { EP08, EP08_LOOK } from "./ep08.ts";
import { EP08_SHELL } from "./Explainer08";
import { PinnedCursor } from "./phoneKit";
import { TallShell } from "./TallShell";

/** Explainer 8, "Talk to your team", for Thandi's Kitchen, on the Reels frame: the chats as a phone. */
export const Explainer08Tall: React.FC = () => (
  <TallShell config={EP08_SHELL} compactAt={EP08.cardIn - 0.6}>
    {(t) => (
      <>
        <ChatPhone t={t} tone={EP08_LOOK} />
        <PinnedCursor t={t} timing={EP08} />
      </>
    )}
  </TallShell>
);
