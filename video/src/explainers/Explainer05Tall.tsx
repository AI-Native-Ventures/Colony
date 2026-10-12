import { EP05 } from "./ep05.ts";
import { EP05_SHELL } from "./Explainer05";
import {
  PhoneApproveCursor,
  RisePhoneCarriers,
  RisePostsPhone,
} from "./RisePostsPhone";
import { TallShell } from "./TallShell";

/** Explainer 5, "Makes your posts", for Rise Bakery, on the Reels frame: the posts as a phone feed. */
export const Explainer05Tall: React.FC = () => (
  <TallShell config={EP05_SHELL} compactAt={EP05.cardIn - 0.6}>
    {(t) => (
      <>
        <RisePostsPhone t={t} />
        <RisePhoneCarriers t={t} />
        <PhoneApproveCursor t={t} />
      </>
    )}
  </TallShell>
);
