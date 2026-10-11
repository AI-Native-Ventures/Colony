import { BEAT, CAMERA } from "./beat.ts";
import { EmployeeHero } from "./EmployeeHero";
import { LOOKS } from "./employees.ts";

/** The proof beat's blue employee, on the proof beat's clock. */
export const EmployeeIntro: React.FC<{ t: number }> = ({ t }) => (
  <EmployeeHero t={t} look={LOOKS.blue} timing={BEAT} camera={CAMERA} />
);
