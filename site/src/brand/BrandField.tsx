import { type CSSProperties, useEffect, useRef, useState } from "react";
import { AntMark } from "./AntMark";
import { WalkingAnt } from "./WalkingAnt";
import "./living-brand.css";

const positions = [
  [5, 17, -24, 46],
  [91, 13, 142, 37],
  [13, 39, 24, 30],
  [84, 35, -36, 42],
  [2, 50, 28, 55],
  [94, 50, 152, 48],
  [8, 88, -18, 33],
  [88, 91, 18, 36],
];

/** Decorative ants animate only while visible and allowed by the owner. */
export function BrandField({ paused }: { paused: boolean }) {
  const field = useRef<HTMLDivElement>(null);
  const ants = useRef<(HTMLDivElement | null)[]>([]);
  const [visible, setVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(!document.hidden);
  const running = visible && pageVisible && !paused;

  useEffect(() => {
    const element = field.current;
    if (!element) return;
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    observer.observe(element);
    const visibilityChanged = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  useEffect(() => {
    const element = field.current;
    const host = element?.parentElement;
    if (!element || !host || !running) return;
    const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
    let frame = 0;
    let pointer: { x: number; y: number } | null = null;
    const update = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const targets = ants.current.map((ant) => {
        if (!ant?.offsetWidth || !pointer) return { x: 0, y: 0 };
        const x = rect.left + ant.offsetLeft + ant.offsetWidth / 2 - pointer.x;
        const y = rect.top + ant.offsetTop + ant.offsetHeight / 2 - pointer.y;
        const distance = Math.hypot(x, y);
        const strength = Math.max(0, 1 - distance / 150);
        return {
          x: distance > 0 ? (x / distance) * strength * 16 : 0,
          y: distance > 0 ? (y / distance) * strength * 10 : 0,
        };
      });
      ants.current.forEach((ant, index) => {
        if (ant)
          ant.style.transform = `translate(${targets[index].x}px, ${targets[index].y}px)`;
      });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || !finePointer.matches) return;
      pointer = { x: event.clientX, y: event.clientY };
      schedule();
    };
    const leave = () => {
      pointer = null;
      schedule();
    };
    host.addEventListener("pointermove", move, { passive: true });
    host.addEventListener("pointerleave", leave);
    return () => {
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerleave", leave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [running]);

  return (
    <div
      ref={field}
      className="brand-field"
      aria-hidden="true"
      data-motion={running ? "running" : "paused"}
    >
      {positions.map(([left, top, rotate, width], index) => (
        <div
          key={`${left}-${top}`}
          ref={(element) => {
            ants.current[index] = element;
          }}
          className={`field-ant field-ant-${index}`}
          style={
            {
              "--ant-left": `${left}%`,
              "--ant-top": `${top}%`,
              "--ant-width": `${width}px`,
              "--ant-angle": `${rotate}deg`,
              "--ant-duration": `${17 + index * 1.7}s`,
              "--ant-phase": `${index * -2.3}s`,
            } as CSSProperties
          }
        >
          <div className="ant-wander">
            <WalkingAnt />
          </div>
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
