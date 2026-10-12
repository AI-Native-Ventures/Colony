import { PANEL_TRANSFORM } from "./frame.ts";

/** The film's cards for a scene, drawn in its panel pixels, placed into the tall card box. */
export const Cards: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    style={{
      position: "absolute",
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      transform: PANEL_TRANSFORM,
      transformOrigin: "0 0",
    }}
  >
    {children}
  </div>
);
