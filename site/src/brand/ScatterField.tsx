// site/src/brand/ScatterField.tsx
// Site version of desktop/src/features/onboarding/ui/LandingAnts.tsx: the
// same fixed-scatter plus wander/pointer-repel physics, at lower density (14
// ants vs 38) and lower opacity (0.5 vs 0.9) so it reads as a hero backdrop
// rather than the focal point. Kept in sync by hand against the desktop
// source, same as the other standalone brand copies in this directory.
import * as React from "react";

import { COLONY_HUES } from "./palette";
import { WalkingAnt } from "./WalkingAnt";

type Ant = {
  top: string;
  left: string;
  size: number;
  rotate: number;
  color: string;
  // Below `sm`, the H1/paragraph span nearly the full 375px viewport width
  // (no side margin the way the desktop max-w-4xl layout has), so any ant
  // whose vertical position falls between the headline and the CTA
  // intrudes on text regardless of its horizontal position. Verified by
  // sweeping worst-case bounding boxes (base position + rotation + full
  // wander amplitude) against the measured mobile text zone: 19 of 26
  // entries land inside it. Relocating all 19 into the ~31%-tall safe band
  // above the headline would just cram them into a tiny strip, so instead
  // they're hidden below `sm` and kept at full density from `sm` up, where
  // the desktop text zone leaves real side margin for them.
  hideOnMobile?: boolean;
};

// Fixed scatter so the field doesn't shimmer between renders. Sized and
// counted to read as a colony rather than dust: bigger ants, denser
// coverage, still a hand-authored static table (no runtime randomness).
const ANTS: Ant[] = [
  { top: "8%", left: "10%", size: 62, rotate: -12, color: COLONY_HUES[0] },
  { top: "12%", left: "82%", size: 54, rotate: 18, color: COLONY_HUES[1] },
  {
    top: "20%",
    left: "45%",
    size: 70,
    rotate: -20,
    color: COLONY_HUES[2],
    hideOnMobile: true,
  },
  {
    top: "28%",
    left: "6%",
    size: 50,
    rotate: 10,
    color: COLONY_HUES[3],
    hideOnMobile: true,
  },
  { top: "18%", left: "65%", size: 58, rotate: -8, color: COLONY_HUES[4] },
  {
    top: "38%",
    left: "90%",
    size: 66,
    rotate: 22,
    color: COLONY_HUES[0],
    hideOnMobile: true,
  },
  {
    top: "45%",
    left: "4%",
    size: 54,
    rotate: -16,
    color: COLONY_HUES[1],
    hideOnMobile: true,
  },
  {
    top: "55%",
    left: "91%",
    size: 62,
    rotate: 14,
    color: COLONY_HUES[2],
    hideOnMobile: true,
  },
  {
    top: "62%",
    left: "6%",
    size: 50,
    rotate: -22,
    color: COLONY_HUES[3],
    hideOnMobile: true,
  },
  {
    top: "70%",
    left: "8%",
    size: 58,
    rotate: 8,
    color: COLONY_HUES[4],
    hideOnMobile: true,
  },
  {
    top: "78%",
    left: "90%",
    size: 66,
    rotate: -10,
    color: COLONY_HUES[0],
    hideOnMobile: true,
  },
  {
    top: "85%",
    left: "85%",
    size: 54,
    rotate: 20,
    color: COLONY_HUES[1],
    hideOnMobile: true,
  },
  {
    top: "90%",
    left: "2%",
    size: 58,
    rotate: -18,
    color: COLONY_HUES[2],
    hideOnMobile: true,
  },
  { top: "5%", left: "35%", size: 46, rotate: 16, color: COLONY_HUES[3] },
  { top: "1%", left: "50%", size: 44, rotate: -6, color: COLONY_HUES[0] },
  { top: "2%", left: "90%", size: 38, rotate: 24, color: COLONY_HUES[2] },
  {
    top: "24%",
    left: "55%",
    size: 48,
    rotate: -14,
    color: COLONY_HUES[4],
    hideOnMobile: true,
  },
  {
    top: "33%",
    left: "72%",
    size: 42,
    rotate: 10,
    color: COLONY_HUES[1],
    hideOnMobile: true,
  },
  {
    top: "42%",
    left: "92%",
    size: 56,
    rotate: -20,
    color: COLONY_HUES[3],
    hideOnMobile: true,
  },
  {
    top: "80%",
    left: "93%",
    size: 40,
    rotate: 16,
    color: COLONY_HUES[2],
    hideOnMobile: true,
  },
  {
    top: "58%",
    left: "92%",
    size: 48,
    rotate: -8,
    color: COLONY_HUES[0],
    hideOnMobile: true,
  },
  {
    top: "68%",
    left: "3%",
    size: 44,
    rotate: 18,
    color: COLONY_HUES[4],
    hideOnMobile: true,
  },
  {
    top: "82%",
    left: "12%",
    size: 52,
    rotate: -12,
    color: COLONY_HUES[1],
    hideOnMobile: true,
  },
  {
    top: "95%",
    left: "68%",
    size: 46,
    rotate: 20,
    color: COLONY_HUES[3],
    hideOnMobile: true,
  },
  {
    top: "96%",
    left: "4%",
    size: 38,
    rotate: -22,
    color: COLONY_HUES[2],
    hideOnMobile: true,
  },
  { top: "0.5%", left: "14%", size: 36, rotate: 14, color: COLONY_HUES[0] },
];

const REPEL_RADIUS = 180;
const REPEL_STRENGTH = 110;
// Autonomous wander: each ant drifts on its own smooth loop.
const WANDER_X = 26;
const WANDER_Y = 20;

/**
 * Fixed scatter of ants wandering and repelling from the pointer, used as
 * the Hero backdrop. The `prefers-reduced-motion` gate wraps both the
 * requestAnimationFrame loop and the pointer-listener registration: when
 * reduced motion is requested, neither ever starts, so each ant stays at
 * its initial CSS `rotate()` transform (set inline below) with no drift and
 * no repel, which is the static fallback state.
 */
export function ScatterField() {
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const antRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  const offsets = React.useRef(ANTS.map(() => ({ x: 0, y: 0 })));

  React.useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = (now - start) / 1000;
      const rect = field.getBoundingClientRect();
      const p = pointer.current;
      antRefs.current.forEach((el, i) => {
        if (!el) return;
        const ant = ANTS[i];
        // Per-ant wander: two incommensurate sine waves, phase-shifted by index.
        const phase = i * 1.7;
        const wx =
          Math.sin(t * (0.7 + (i % 5) * 0.13) + phase) * WANDER_X +
          Math.sin(t * 1.9 + phase * 2.1) * 6;
        const wy =
          Math.cos(t * (0.6 + (i % 7) * 0.11) + phase) * WANDER_Y +
          Math.cos(t * 2.3 + phase * 1.3) * 5;
        let rx = 0;
        let ry = 0;
        if (p) {
          const cx = rect.left + (rect.width * parseFloat(ant.left)) / 100;
          const cy = rect.top + (rect.height * parseFloat(ant.top)) / 100;
          const ox = cx - p.x;
          const oy = cy - p.y;
          const dist = Math.hypot(ox, oy);
          if (dist < REPEL_RADIUS && dist > 0.01) {
            const push =
              ((REPEL_RADIUS - dist) / REPEL_RADIUS) * REPEL_STRENGTH;
            rx = (ox / dist) * push;
            ry = (oy / dist) * push;
          }
        }
        // Ease toward the combined target so repulsion enters/exits smoothly.
        const target = { x: wx + rx, y: wy + ry };
        const cur = offsets.current[i];
        cur.x += (target.x - cur.x) * 0.12;
        cur.y += (target.y - cur.y) * 0.12;
        el.style.transform = `translate(${cur.x}px, ${cur.y}px) rotate(${ant.rotate}deg)`;
      });
      raf = requestAnimationFrame(tick);
    };

    const onMove = (event: MouseEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    const onLeave = () => {
      pointer.current = null;
    };

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!reduced.matches) {
      raf = requestAnimationFrame(tick);
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseout", onLeave);
    }
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseout", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div
      ref={fieldRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {ANTS.map((ant, i) => (
        <span
          key={`${ant.top}-${ant.left}`}
          ref={(el) => {
            antRefs.current[i] = el;
          }}
          className={
            ant.hideOnMobile
              ? "absolute hidden will-change-transform sm:block"
              : "absolute block will-change-transform"
          }
          style={{
            top: ant.top,
            left: ant.left,
            width: ant.size,
            color: ant.color,
            transform: `rotate(${ant.rotate}deg)`,
            opacity: 0.5,
          }}
        >
          <WalkingAnt className="w-full" />
        </span>
      ))}
    </div>
  );
}
