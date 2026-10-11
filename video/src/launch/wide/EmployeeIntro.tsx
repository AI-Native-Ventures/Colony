import { BEAT, CAMERA } from "./beat.ts";
import { EmployeeHero, type HeroLook } from "./EmployeeHero";

export const BLUE_LOOK: HeroLook = {
  color: "hsl(217 91% 60%)",
  deep: "hsl(217 80% 46%)",
  title: ["Finds", "customers."],
  subline: "Finds businesses near you that need what you sell.",
};

/** The proof beat's blue employee, on the proof beat's clock. */
export const EmployeeIntro: React.FC<{ t: number }> = ({ t }) => (
  <EmployeeHero t={t} look={BLUE_LOOK} timing={BEAT} camera={CAMERA} />
);
