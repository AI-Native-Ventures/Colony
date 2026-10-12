import { EP05_SHELL, ep05Work } from "./Explainer05";
import { TallShell } from "./TallShell";

/** Explainer 5, "Makes your posts", for Rise Bakery, on the Reels frame. */
export const Explainer05Tall: React.FC = () => (
  <TallShell config={EP05_SHELL}>{ep05Work}</TallShell>
);
