import { INTER } from "../launch/fonts";
import { easeOutExpo, progress } from "../launch/math.ts";
import { PHONE_CARD } from "./phone.ts";

const INK = "#17151f";
const LINE = "#ece9f4";

/**
 * The phone-style card an upright explainer draws its work in: white,
 * rounded, rising into place at `enterAt`. Children are in card pixels.
 */
export const PhoneCard: React.FC<{
  t: number;
  enterAt: number;
  /** The shadow's colour, from the employee's tone. */
  glow: string;
  children: React.ReactNode;
}> = ({ t, enterAt, glow, children }) => {
  const enter = easeOutExpo(progress(t, enterAt, 0.9));
  if (enter <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: PHONE_CARD.x,
        top: PHONE_CARD.y,
        width: PHONE_CARD.w,
        height: PHONE_CARD.h,
        borderRadius: 44,
        background: "#ffffff",
        border: `1.5px solid ${LINE}`,
        boxSizing: "border-box",
        boxShadow: `0 60px 120px -60px ${glow}`,
        overflow: "hidden",
        fontFamily: INTER,
        color: INK,
        opacity: enter,
        transform: `translateY(${((1 - enter) * 90).toFixed(2)}px)`,
        filter:
          enter < 1 ? `blur(${((1 - enter) * 10).toFixed(2)}px)` : undefined,
      }}
    >
      {children}
    </div>
  );
};
