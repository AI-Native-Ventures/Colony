import type { CSSProperties } from "react";
import { AntMark } from "./AntMark";

const positions = [
  [5, 17, -24, 46],
  [91, 13, 142, 37],
  [13, 39, 24, 30],
  [84, 35, -36, 42],
  [2, 63, 28, 55],
  [94, 66, 152, 48],
  [8, 88, -18, 33],
  [88, 91, 18, 36],
];

/** Decorative brand marks stay outside reading areas and never intercept input. */
export function BrandField() {
  return (
    <div className="brand-field" aria-hidden="true">
      {positions.map(([left, top, rotate, width], index) => (
        <div
          key={`${left}-${top}`}
          className={`field-ant field-ant-${index}`}
          style={
            {
              "--ant-left": `${left}%`,
              "--ant-top": `${top}%`,
              "--ant-width": `${width}px`,
              "--ant-angle": `${rotate}deg`,
              "--ant-delay": `${index * 0.08}s`,
            } as CSSProperties
          }
        >
          <AntMark />
        </div>
      ))}
    </div>
  );
}

export function AntParade() {
  return (
    <div className="ant-parade" aria-hidden="true">
      {["violet", "blue", "green", "amber", "pink"].map((colour) => (
        <span className={`parade-ant ${colour}`} key={colour}>
          <AntMark />
        </span>
      ))}
    </div>
  );
}
