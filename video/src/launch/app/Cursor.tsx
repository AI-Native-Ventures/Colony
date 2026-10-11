import { easeInOutCubic, progress } from "../math.ts";

export type CursorKey = { at: number; x: number; y: number };

/** Where the pointer is at `t`, gliding between keyframes (content coordinates). */
export function cursorAt(
  keys: readonly CursorKey[],
  t: number,
): { x: number; y: number } {
  if (t <= keys[0].at) return { x: keys[0].x, y: keys[0].y };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.at) {
      const e = easeInOutCubic(progress(t, a.at, b.at - a.at));
      return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
    }
  }
  const last = keys[keys.length - 1];
  return { x: last.x, y: last.y };
}

/** A desktop pointer with a violet ring on each click. */
export const Cursor: React.FC<{
  t: number;
  keys: readonly CursorKey[];
  clicks: readonly number[];
  opacity: number;
}> = ({ t, keys, clicks, opacity }) => {
  const { x, y } = cursorAt(keys, t);
  const pressing = clicks.some((c) => t >= c && t < c + 0.12);
  return (
    <>
      {clicks.map((c) => {
        const r = progress(t, c, 0.5);
        if (r <= 0 || r >= 1) return null;
        const at = cursorAt(keys, c);
        return (
          <div
            key={c}
            style={{
              position: "absolute",
              left: at.x - 50,
              top: at.y - 50,
              width: 100,
              height: 100,
              borderRadius: "50%",
              border: `5px solid hsl(258 90% 66% / ${(0.8 * (1 - r)).toFixed(3)})`,
              transform: `scale(${(0.3 + 1.1 * r).toFixed(3)})`,
            }}
          />
        );
      })}
      <svg
        aria-hidden="true"
        width={46}
        height={62}
        viewBox="0 0 23 31"
        style={{
          position: "absolute",
          left: x - 3,
          top: y - 2,
          opacity,
          transform: `scale(${pressing ? 0.86 : 1})`,
          transformOrigin: "3px 2px",
          filter: "drop-shadow(0 6px 10px rgb(0 0 0 / 0.35))",
        }}
      >
        <path
          d="M2 1 L2 25 L8 19.5 L12.5 29 L16.5 27.2 L12 18 L20 18 Z"
          fill="#fff"
          stroke="#111"
          strokeWidth={1.6}
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
};
