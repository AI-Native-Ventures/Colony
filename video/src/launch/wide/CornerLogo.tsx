import { AntMark } from "../../brand/AntMark";
import { INTER } from "../fonts";
import { smoothstep } from "../math.ts";

/** A small Colony lockup in the top left corner, so every frame says whose film this is. */
export const CornerLogo: React.FC<{ t: number; from: number; to: number }> = ({
  t,
  from,
  to,
}) => {
  const show =
    smoothstep(from, from + 0.5, t) * (1 - smoothstep(to - 0.4, to, t));
  if (show <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: 60,
        top: 42,
        display: "flex",
        alignItems: "center",
        gap: 12,
        fontFamily: INTER,
        fontSize: 28,
        fontWeight: 800,
        letterSpacing: "-0.02em",
        color: "#17151f",
        opacity: show,
      }}
    >
      <span
        style={{
          display: "flex",
          width: 46,
          height: 30,
          color: "hsl(258 90% 66%)",
        }}
      >
        <AntMark />
      </span>
      Colony
    </div>
  );
};
