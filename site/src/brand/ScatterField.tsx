// site/src/brand/ScatterField.tsx
// Site version of desktop/src/features/onboarding/ui/LandingAnts.tsx: the
// same fixed-scatter plus wander/pointer-repel physics, using the winged
// variant (WingedAnt, scatter-field-only per docs/BRAND.md) at lower
// density and opacity than the desktop original so it reads as a hero
// backdrop rather than the focal point. Kept in sync by hand against the
// desktop source, same as the other standalone brand copies in this
// directory.
import * as React from "react";

import { getActiveHue, HUE_SCATTER_TONES } from "./hue";
import { WingedAnt } from "./WingedAnt";

type Ant = {
  top: string;
  left: string;
  size: number;
  rotate: number;
  // Index into the active hue's tonal scale (HUE_SCATTER_TONES), not a
  // literal color: the actual hue is picked at load, so color must be
  // resolved at render time. Positions and this index stay fixed regardless
  // of which hue loads; only the tone each index resolves to changes.
  toneIndex: number;
  // The hero is now asymmetric (wordmark hard left, copy set right) and on
  // mobile those stack into one tall column that spans nearly the full
  // 375px viewport width with no side margin. Any ant positioned between
  // the badge and the CTA row intrudes on that column regardless of its
  // horizontal position, so most entries are desktop-only; the handful left
  // visible on mobile sit in the thin padding bands above the badge and
  // below the CTA row, verified against the rendered mobile layout.
  hideOnMobile?: boolean;
};

// Fixed scatter so the field doesn't shimmer between renders. Framed around
// the two-column hero content (wordmark left, copy right) rather than a
// centered block: most ants sit in the outer edge margins, the top/bottom
// padding bands, and the vertical gap between the two columns.
const ANTS: Ant[] = [
  // Visible at every width: kept inside the top/bottom padding bands, clear
  // of the content column at both 375px (stacked) and desktop (two-up).
  { top: "1%", left: "10%", size: 30, rotate: -14, toneIndex: 0 },
  { top: "2.5%", left: "86%", size: 26, rotate: 18, toneIndex: 2 },
  { top: "0.5%", left: "48%", size: 24, rotate: 8, toneIndex: 3 },
  { top: "97%", left: "18%", size: 28, rotate: -10, toneIndex: 1 },
  { top: "98%", left: "78%", size: 26, rotate: 16, toneIndex: 0 },

  // Left edge, outside the wordmark column.
  {
    top: "8%",
    left: "3%",
    size: 50,
    rotate: -12,
    toneIndex: 0,
    hideOnMobile: true,
  },
  {
    top: "20%",
    left: "1.5%",
    size: 44,
    rotate: 10,
    toneIndex: 2,
    hideOnMobile: true,
  },
  {
    top: "33%",
    left: "2.5%",
    size: 56,
    rotate: -18,
    toneIndex: 1,
    hideOnMobile: true,
  },
  {
    top: "48%",
    left: "1%",
    size: 48,
    rotate: 14,
    toneIndex: 3,
    hideOnMobile: true,
  },
  {
    top: "63%",
    left: "2.5%",
    size: 52,
    rotate: -20,
    toneIndex: 0,
    hideOnMobile: true,
  },
  {
    top: "78%",
    left: "1.5%",
    size: 46,
    rotate: 12,
    toneIndex: 2,
    hideOnMobile: true,
  },
  {
    top: "90%",
    left: "3%",
    size: 40,
    rotate: -8,
    toneIndex: 1,
    hideOnMobile: true,
  },

  // Right edge, outside the copy column.
  {
    top: "10%",
    left: "97%",
    size: 50,
    rotate: 16,
    toneIndex: 1,
    hideOnMobile: true,
  },
  {
    top: "24%",
    left: "98.5%",
    size: 42,
    rotate: -14,
    toneIndex: 3,
    hideOnMobile: true,
  },
  {
    top: "38%",
    left: "97.5%",
    size: 54,
    rotate: 20,
    toneIndex: 0,
    hideOnMobile: true,
  },
  {
    top: "53%",
    left: "98.5%",
    size: 46,
    rotate: -10,
    toneIndex: 2,
    hideOnMobile: true,
  },
  {
    top: "68%",
    left: "97%",
    size: 50,
    rotate: 18,
    toneIndex: 1,
    hideOnMobile: true,
  },
  {
    top: "82%",
    left: "98%",
    size: 40,
    rotate: -16,
    toneIndex: 3,
    hideOnMobile: true,
  },
  {
    top: "93%",
    left: "96%",
    size: 36,
    rotate: 10,
    toneIndex: 0,
    hideOnMobile: true,
  },

  // Top/bottom padding bands, desktop-only supplements.
  {
    top: "4%",
    left: "30%",
    size: 34,
    rotate: -8,
    toneIndex: 2,
    hideOnMobile: true,
  },
  {
    top: "5%",
    left: "68%",
    size: 30,
    rotate: 14,
    toneIndex: 1,
    hideOnMobile: true,
  },
  {
    top: "95%",
    left: "40%",
    size: 32,
    rotate: -12,
    toneIndex: 3,
    hideOnMobile: true,
  },
  {
    top: "96%",
    left: "62%",
    size: 28,
    rotate: 10,
    toneIndex: 0,
    hideOnMobile: true,
  },
  // No entry in the gap between the two columns: measured against the
  // rendered h1 bounding box at 1440x900, that strip clips the headline's
  // wrap width even at a small size (removed after overlap-check.mjs
  // caught it during verification).
];

const REPEL_RADIUS = 180;
const REPEL_STRENGTH = 110;
// Autonomous wander: each ant drifts on its own smooth loop.
const WANDER_X = 26;
const WANDER_Y = 20;

/**
 * Fixed scatter of winged ants wandering and repelling from the pointer,
 * used as the Hero backdrop. The `prefers-reduced-motion` gate wraps both
 * the requestAnimationFrame loop and the pointer-listener registration:
 * when reduced motion is requested, neither ever starts, so each ant stays
 * at its initial CSS `rotate()` transform (set inline below) with no drift
 * and no repel, which is the static fallback state. WingedAnt's own wing
 * flap has its own separate CSS-only reduced-motion fallback (see
 * site-animations.css).
 */
export function ScatterField() {
  const fieldRef = React.useRef<HTMLDivElement>(null);
  const antRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  const offsets = React.useRef(ANTS.map(() => ({ x: 0, y: 0 })));
  const tones = HUE_SCATTER_TONES[getActiveHue()];

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
            color: tones[ant.toneIndex % tones.length],
            transform: `rotate(${ant.rotate}deg)`,
            opacity: 0.5,
          }}
        >
          <WingedAnt className="w-full" />
        </span>
      ))}
    </div>
  );
}
