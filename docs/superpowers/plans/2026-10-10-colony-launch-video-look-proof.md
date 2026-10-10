# Colony Launch Video: Look Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (the owner does not allow Claude Code subagents, so subagent-driven development is out). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build step 1 of 4 from the spec, the look proof: 6 silent seconds where a crammed stack of job words breaks into a swarm of tiny Colony ants that stream in four colored rivers and lock into the Colony logo, plus a finished hero still, so the owner can judge the "$10M launch" look before anything else is built.

**Architecture:** A new `LaunchProof` Remotion composition in the standalone `video/` package. Pure, Node-tested modules hold all math (seeded random, easing, point sampling, the ant flight model); thin React layers draw words and ants on canvas each frame as a pure function of time in seconds. Target point sets (word glyphs, logo silhouette) are sampled once per render tab from offscreen canvases after the Inter font loads.

**Tech Stack:** Remotion 4.0.522, React 19.2.8, TypeScript 6.0.3, Biome 2.4.16, `@remotion/google-fonts` (Inter), Canvas 2D, Node 24 built-in test runner with type stripping, ffmpeg 8.1 for gates.

**Spec:** `docs/superpowers/specs/2026-10-10-colony-launch-video-design.html` (sections "How the swarm works", "The look", "How we build it" step 1, "Checks before you see anything", "For the builder").

## Global Constraints

- Frame: 1080 by 1920. 30 fps, plus a 60 fps render of the same proof to compare ("Try 60 fps in the look proof; keep it only if it renders in reasonable time and looks clearly smoother").
- Package: standalone `video/` (Remotion 4.0.522, own `pnpm-lock.yaml`, `.npmrc` `ignore-workspace=true`). Never touch the workspace `pnpm-lock.yaml`.
- Every frame must be a pure function of time. No `Math.random`, no state carried between frames.
- Brand hues exactly: violet `hsl(258 90% 66%)`, blue `hsl(217 91% 60%)`, pink `hsl(330 81% 60%)`, amber `hsl(38 92% 50%)`, green `hsl(160 60% 45%)`. Violet is Colony itself; the four others are the four employees.
- The logo keeps its true 466:309 shape from `src/brand/AntMark.tsx` (source of truth `docs/BRAND.md`). No gradients or outlines on the mark.
- Words stay inside the phone safe area: roughly 90 to 940 px across and 150 to 1500 px down.
- Copy: no long dashes. Never on screen: agent, workspace, model, channel, relay, token.
- Motion graphics only. No AI video, no cartoon characters. The proof is silent.
- Font: Inter (the brand font), loaded through `@remotion/google-fonts`.

## Review Focus

1. **Font fallback while sampling:** if Inter 800 is not loaded when the word glyphs are sampled, the ants spell a fallback font's shapes and miss the drawn words. Expected: the render fails loudly, never silently mismatches. Pinned in Task 4 (explicit `document.fonts.check` plus `cancelRender`).
2. **Parallel, out-of-order frame rendering:** any hidden state or unseeded random makes frames flicker. Expected: the same frame renders to identical pixels every time. Pinned in Task 1 (source guard test) and Task 6 (render one still twice, compare hashes).
3. **A long job phrase:** "Update the website" at full size runs under the TikTok and Reels buttons or off frame. Expected: every line auto-fits inside x 140 to 940. Pinned in Task 2 (`fitFontSize` tests) and Task 1 (safe-area test).
4. **60 fps versus 30 fps:** motion written in frames would run twice as fast at 60 fps. Expected: identical timing in seconds. Pinned in Task 1 (`timeAt` test) and Task 6 (60 fps render).
5. **A near-black first frame:** the opening is dark by design; a viewer who sees nothing scrolls away. Expected: visible light from frame 0 (the glowing solo ant). Pinned in Task 6 (brightness gate on frame 0 and every sampled frame).

---

### Task 1: Pure math, colors, timeline and test setup

**Files:**
- Create: `video/src/launch/math.ts`, `video/src/launch/colors.ts`, `video/src/launch/timeline.ts` (needs the `Lane` type from Task 3; write Task 3's `swarm.ts` type exports first if executing out of order)
- Create: `video/src/launch/math.test.ts`, `video/src/launch/timeline.test.ts`
- Modify: `video/package.json` (add `test` script), `video/tsconfig.json` (exclude tests from `tsc`)

**Interfaces:**
- Produces: `mulberry32(seed): () => number`, `clamp01`, `lerp`, `progress(t, start, duration)`, `smoothstep(e0, e1, x)`, `easeInOutCubic`, `easeOutExpo`, `lerpAngle(a, b, t)`, `hslToRgb(h, s, l): [number, number, number]`; `antColor(group, toGroup, toViolet): string`; timeline constants `FRAME_W`, `FRAME_H`, `PROOF_SECONDS`, `SEED`, `ANT_COUNT`, `T_TREMBLE`, `T_RELEASE`, `RELEASE_SWEEP`, `T_LOGO_IN`, `T_TEXT_1`, `T_TEXT_2`, `LOGO_RECT`, `TEXT_MAX_WIDTH`, `LANES`, `timeAt(frame, fps)`.

- [ ] **Step 1: Install the package and add the test script**

Run: `cd video && pnpm install --frozen-lockfile`
Expected: `node_modules/` created, `pnpm-lock.yaml` unchanged (`git diff --stat video/pnpm-lock.yaml` prints nothing).

In `video/package.json` add to `scripts`:

```json
"test": "node --test src/launch/*.test.ts",
```

In `video/tsconfig.json` add after `"include": ["src"]`:

```json
"exclude": ["src/**/*.test.ts"]
```

- [ ] **Step 2: Write the failing tests**

`video/src/launch/math.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  easeInOutCubic,
  easeOutExpo,
  hslToRgb,
  lerpAngle,
  mulberry32,
  progress,
  smoothstep,
} from "./math.ts";

test("mulberry32 repeats exactly for the same seed", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  for (const v of seqA) assert.ok(v >= 0 && v < 1);
  assert.notDeepEqual(seqA, [mulberry32(43)(), 0, 0, 0]);
});

test("easings hit their ends and clamp outside 0..1", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  assert.equal(easeInOutCubic(0.5), 0.5);
  assert.equal(easeInOutCubic(-3), 0);
  assert.equal(easeInOutCubic(7), 1);
  assert.equal(easeOutExpo(0), 0);
  assert.equal(easeOutExpo(1), 1);
});

test("progress and smoothstep clamp", () => {
  assert.equal(progress(0, 1, 2), 0);
  assert.equal(progress(2, 1, 2), 0.5);
  assert.equal(progress(9, 1, 2), 1);
  assert.equal(smoothstep(0, 1, -1), 0);
  assert.equal(smoothstep(0, 1, 0.5), 0.5);
  assert.equal(smoothstep(0, 1, 2), 1);
});

test("lerpAngle goes the short way round", () => {
  const mid = lerpAngle(3.0, -3.0, 0.5);
  assert.ok(Math.abs(Math.abs(mid) - Math.PI) < 1e-9, `got ${mid}`);
});

test("hslToRgb matches the brand hues", () => {
  assert.deepEqual(hslToRgb(258, 90, 66), [137, 90, 246]);
  assert.deepEqual(hslToRgb(217, 91, 60), [60, 131, 246]);
  assert.deepEqual(hslToRgb(330, 81, 60), [236, 70, 153]);
  assert.deepEqual(hslToRgb(38, 92, 50), [245, 159, 10]);
  assert.deepEqual(hslToRgb(160, 60, 45), [46, 184, 138]);
});
```

`video/src/launch/timeline.test.ts`:

```ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { antColor } from "./colors.ts";
import { FRAME_W, LOGO_RECT, TEXT_MAX_WIDTH, timeAt } from "./timeline.ts";

test("timing is in seconds, so 30 and 60 fps agree", () => {
  assert.equal(timeAt(90, 30), timeAt(180, 60));
  assert.equal(timeAt(168, 30), 5.6);
});

test("the logo keeps the 466:309 brand ratio", () => {
  assert.ok(Math.abs(LOGO_RECT.width / LOGO_RECT.height - 466 / 309) < 1e-9);
});

test("words stay inside the safe area (x 90..940)", () => {
  const left = FRAME_W / 2 - TEXT_MAX_WIDTH / 2;
  const right = FRAME_W / 2 + TEXT_MAX_WIDTH / 2;
  assert.ok(left >= 90, `left edge ${left}`);
  assert.ok(right <= 940, `right edge ${right}`);
});

test("ant colors run white, then employee color, then violet", () => {
  assert.equal(antColor(0, 0, 0), "rgb(244 243 248)");
  assert.equal(antColor(0, 1, 0), "rgb(60 131 246)");
  assert.equal(antColor(2, 1, 1), "rgb(137 90 246)");
});

test("no unseeded randomness anywhere in the launch film", () => {
  const dir = new URL(".", import.meta.url);
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".test.ts")) continue;
    const src = readFileSync(new URL(name, dir), "utf8");
    assert.ok(!src.includes("Math.random"), `${name} uses Math.random`);
  }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd video && pnpm test`
Expected: FAIL, `Cannot find module` for `./math.ts`, `./colors.ts`, `./timeline.ts`.

- [ ] **Step 4: Write the implementation**

`video/src/launch/math.ts`:

```ts
/**
 * Small pure helpers for the launch film. Everything here is a pure
 * function, so any frame can render alone, in any order, in any tab.
 */

/** Deterministic PRNG (mulberry32): the same seed gives the same sequence everywhere. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 0 before `start`, 1 after `start + duration`, linear in between. */
export function progress(t: number, start: number, duration: number): number {
  return clamp01((t - start) / duration);
}

/** Hermite smoothstep between two edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function easeInOutCubic(x: number): number {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

export function easeOutExpo(x: number): number {
  const t = clamp01(x);
  return t === 1 ? 1 : 1 - 2 ** (-10 * t);
}

/** Interpolates two angles in radians along the shorter way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  const full = Math.PI * 2;
  let d = (b - a) % full;
  if (d > Math.PI) d -= full;
  if (d < -Math.PI) d += full;
  return a + d * t;
}

/** CSS hsl() (degrees, percent, percent) to 0..255 RGB. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = lig - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}
```

`video/src/launch/colors.ts`:

```ts
import { hslToRgb, lerp } from "./math.ts";

type Rgb = [number, number, number];

/** The four employees, in group order: finds customers, posts, emails, website. */
const GROUP_RGB: Rgb[] = [
  hslToRgb(217, 91, 60),
  hslToRgb(330, 81, 60),
  hslToRgb(38, 92, 50),
  hslToRgb(160, 60, 45),
];
const VIOLET_RGB: Rgb = hslToRgb(258, 90, 66);
const WHITE_RGB: Rgb = [244, 243, 248];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t)),
  ];
}

/** White while the ant is still a letter, its employee color in flight, violet once it is part of the logo. */
export function antColor(group: number, toGroup: number, toViolet: number): string {
  const own = GROUP_RGB[group % GROUP_RGB.length];
  const [r, g, b] = mix(mix(WHITE_RGB, own, toGroup), VIOLET_RGB, toViolet);
  return `rgb(${r} ${g} ${b})`;
}
```

`video/src/launch/timeline.ts`:

```ts
import type { Lane } from "./swarm.ts";

/** Every time in the film is in seconds, so 30 fps and 60 fps renders match. */
export const FRAME_W = 1080;
export const FRAME_H = 1920;
export const PROOF_SECONDS = 6;
export const SEED = 20261010;
export const ANT_COUNT = 1400;

export const T_TREMBLE = 1.55;
export const T_RELEASE = 2.0;
/** Seconds from the first ant leaving (left edge) to the last (right edge). */
export const RELEASE_SWEEP = 0.45;
export const T_LOGO_IN = 4.25;
export const T_TEXT_1 = 4.45;
export const T_TEXT_2 = 4.62;

/** Where the logo lands: centered, 700 px wide, 466:309 like the brand mark. */
export const LOGO_RECT = {
  cx: 540,
  cy: 800,
  width: 700,
  height: 700 * (309 / 466),
};

/** Words stay inside x 140..940, clear of the TikTok and Reels buttons. */
export const TEXT_MAX_WIDTH = 800;

/** Four rivers, one per employee color: out towards the edges, then back into the logo. */
export const LANES: Lane[] = [
  { c1: { x: -180, y: 1150 }, c2: { x: 60, y: 260 }, spread: 110 },
  { c1: { x: 1260, y: 1250 }, c2: { x: 1020, y: 300 }, spread: 110 },
  { c1: { x: 160, y: 1900 }, c2: { x: -120, y: 700 }, spread: 120 },
  { c1: { x: 920, y: 1900 }, c2: { x: 1200, y: 760 }, spread: 120 },
];

export const timeAt = (frame: number, fps: number): number => frame / fps;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd video && pnpm test`
Expected: PASS for `math.test.ts`; `timeline.test.ts` passes once Task 3's `swarm.ts` exists (it only imports the `Lane` type, which Node strips, so it passes now too).

- [ ] **Step 6: Commit**

```bash
git add video/package.json video/tsconfig.json video/src/launch/math.ts video/src/launch/colors.ts video/src/launch/timeline.ts video/src/launch/math.test.ts video/src/launch/timeline.test.ts
git commit -s -m "video(launch): pure math, brand colors and timeline for the look proof"
```

---

### Task 2: Point sampling and text fitting

**Files:**
- Create: `video/src/launch/points.ts`, `video/src/launch/points.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Point = { x: number; y: number }`, `sampleAlphaPoints(rgba, width, height, step, threshold = 128): Point[]`, `pickPoints(pool, n, rand): Point[]`, `fitFontSize(measureAtSize, desired, maxWidth): number`.

- [ ] **Step 1: Write the failing test**

`video/src/launch/points.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "./math.ts";
import { fitFontSize, pickPoints, sampleAlphaPoints } from "./points.ts";

function block(width: number, height: number, alpha: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 3; y <= 5; y++)
    for (let x = 2; x <= 4; x++) rgba[(y * width + x) * 4 + 3] = alpha;
  return rgba;
}

test("samples only opaque cells on the grid", () => {
  assert.equal(sampleAlphaPoints(block(10, 10, 255), 10, 10, 1).length, 9);
  assert.deepEqual(sampleAlphaPoints(block(10, 10, 255), 10, 10, 2), [
    { x: 3, y: 3 },
    { x: 3, y: 5 },
  ]);
});

test("respects the alpha threshold", () => {
  assert.equal(sampleAlphaPoints(block(10, 10, 100), 10, 10, 1).length, 0);
  assert.equal(sampleAlphaPoints(block(10, 10, 100), 10, 10, 1, 90).length, 9);
});

test("pickPoints returns exactly n, deterministically, cycling a small pool", () => {
  const pool = [
    { x: 1, y: 1 },
    { x: 2, y: 2 },
    { x: 3, y: 3 },
  ];
  const a = pickPoints(pool, 7, mulberry32(5));
  const b = pickPoints(pool, 7, mulberry32(5));
  assert.equal(a.length, 7);
  assert.deepEqual(a, b);
  for (const p of a) assert.ok(pool.includes(p));
});

test("pickPoints refuses an empty pool", () => {
  assert.throws(() => pickPoints([], 3, mulberry32(1)), /empty pool/);
});

test("fitFontSize shrinks long lines and leaves short ones alone", () => {
  const measure = (size: number) => size * 5;
  assert.equal(fitFontSize(measure, 100, 400), 80);
  assert.equal(fitFontSize(measure, 100, 600), 100);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd video && pnpm test`
Expected: FAIL, `Cannot find module './points.ts'`.

- [ ] **Step 3: Write the implementation**

`video/src/launch/points.ts`:

```ts
export type Point = { x: number; y: number };

/**
 * Grid-samples the positions whose alpha is at least `threshold`.
 * `rgba` uses the ImageData layout: 4 bytes per pixel, alpha last.
 */
export function sampleAlphaPoints(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  step: number,
  threshold = 128,
): Point[] {
  const out: Point[] = [];
  const first = Math.floor(step / 2);
  for (let y = first; y < height; y += step) {
    for (let x = first; x < width; x += step) {
      if (rgba[(y * width + x) * 4 + 3] >= threshold) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Picks exactly `n` points from `pool` in a seeded shuffle order, cycling
 * the pool when it is smaller than `n`. Throws on an empty pool, because an
 * empty pool means nothing was drawn where we sampled.
 */
export function pickPoints(pool: Point[], n: number, rand: () => number): Point[] {
  if (pool.length === 0) {
    throw new Error("pickPoints: empty pool, nothing was drawn to sample");
  }
  const order = pool.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const out: Point[] = [];
  for (let i = 0; i < n; i++) out.push(pool[order[i % order.length]]);
  return out;
}

/** The largest size up to `desired` whose measured width fits `maxWidth`. Width must scale linearly with size. */
export function fitFontSize(
  measureAtSize: (size: number) => number,
  desired: number,
  maxWidth: number,
): number {
  const width = measureAtSize(desired);
  return width <= maxWidth ? desired : Math.floor(desired * (maxWidth / width));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd video && pnpm test`
Expected: PASS, all `points.test.ts` tests.

- [ ] **Step 5: Commit**

```bash
git add video/src/launch/points.ts video/src/launch/points.test.ts
git commit -s -m "video(launch): sample target points from alpha and fit long lines"
```

---

### Task 3: The ant flight model

**Files:**
- Create: `video/src/launch/swarm.ts`, `video/src/launch/swarm.test.ts`

**Interfaces:**
- Consumes: `mulberry32`, `clamp01`, `easeInOutCubic`, `lerpAngle`, `smoothstep` (Task 1); `Point` (Task 2).
- Produces: `type Lane = { c1: Point; c2: Point; spread: number }`, `type Ant`, `type AntState = { x; y; angle; size; alpha; toGroup; toViolet }`, `bezier(p0, p1, p2, p3, u): Point`, `bezierTangent(...)`, `createAnts(starts, ends, lanes, { seed, releaseAt, sweep, frameWidth }): Ant[]`, `antState(ant, t): AntState`.

- [ ] **Step 1: Write the failing test**

`video/src/launch/swarm.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mulberry32 } from "./math.ts";
import type { Point } from "./points.ts";
import { type Lane, antState, createAnts } from "./swarm.ts";

const lanes: Lane[] = [
  { c1: { x: -100, y: 1000 }, c2: { x: 100, y: 300 }, spread: 80 },
  { c1: { x: 1180, y: 1000 }, c2: { x: 980, y: 300 }, spread: 80 },
];

function points(n: number, seed: number, cx: number, cy: number): Point[] {
  const r = mulberry32(seed);
  return Array.from({ length: n }, () => ({
    x: cx + (r() - 0.5) * 600,
    y: cy + (r() - 0.5) * 300,
  }));
}

const starts = points(200, 1, 540, 960);
const ends = points(200, 2, 540, 800);
const opts = { seed: 7, releaseAt: 2, sweep: 0.45, frameWidth: 1080 };

test("createAnts is deterministic", () => {
  assert.deepEqual(createAnts(starts, ends, lanes, opts), createAnts(starts, ends, lanes, opts));
});

test("every start and every end is used exactly once", () => {
  const ants = createAnts(starts, ends, lanes, opts);
  assert.equal(ants.length, 200);
  assert.equal(new Set(ants.map((a) => a.start)).size, 200);
  assert.equal(new Set(ants.map((a) => a.end)).size, 200);
});

test("refuses mismatched point sets", () => {
  assert.throws(() => createAnts(starts, ends.slice(1), lanes, opts), /199 ends/);
});

test("each river stays inside its lane spread", () => {
  for (const ant of createAnts(starts, ends, lanes, opts)) {
    const lane = lanes[ant.group];
    assert.ok(Math.abs(ant.c1.x - lane.c1.x) <= lane.spread);
    assert.ok(Math.abs(ant.c2.y - lane.c2.y) <= lane.spread);
  }
});

test("an ant sits on its letter before release and on the logo after landing", () => {
  for (const ant of createAnts(starts, ends, lanes, opts).slice(0, 20)) {
    const before = antState(ant, ant.release - 0.01);
    assert.equal(before.x, ant.start.x);
    assert.equal(before.y, ant.start.y);
    assert.equal(before.toGroup, 0);
    const after = antState(ant, ant.release + ant.duration + 0.5);
    assert.ok(Math.abs(after.x - ant.end.x) < 1e-6);
    assert.ok(Math.abs(after.y - ant.end.y) < 1e-6);
    assert.equal(after.toViolet, 1);
    assert.ok(Math.abs(after.angle) < 1e-9);
  }
});

test("ants are invisible before they appear", () => {
  const ant = createAnts(starts, ends, lanes, opts)[0];
  assert.equal(antState(ant, ant.appear - 0.01).alpha, 0);
  assert.equal(antState(ant, ant.appear + 0.2).alpha, 1);
});

test("no ant teleports between neighbouring moments", () => {
  for (const ant of createAnts(starts, ends, lanes, opts).slice(0, 40)) {
    let prev = antState(ant, ant.release - 0.05);
    for (let t = ant.release - 0.05; t < ant.release + ant.duration + 0.05; t += 1 / 240) {
      const next = antState(ant, t);
      assert.ok(Math.hypot(next.x - prev.x, next.y - prev.y) < 40, `jump at t=${t}`);
      prev = next;
    }
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd video && pnpm test`
Expected: FAIL, `Cannot find module './swarm.ts'`.

- [ ] **Step 3: Write the implementation**

`video/src/launch/swarm.ts`:

```ts
import { clamp01, easeInOutCubic, lerpAngle, mulberry32, smoothstep } from "./math.ts";
import type { Point } from "./points.ts";

/** One colored river: every ant in the group bends through these two control points, give or take `spread`. */
export type Lane = { c1: Point; c2: Point; spread: number };

export type Ant = {
  start: Point;
  end: Point;
  c1: Point;
  c2: Point;
  group: number;
  /** Seconds when the ant fades in on its letter. */
  appear: number;
  /** Seconds when it leaves its letter. */
  release: number;
  /** Seconds of flight. */
  duration: number;
  wobbleAmp: number;
  wobblePhase: number;
  /** Length in px while flying. */
  size: number;
};

export type AntState = {
  x: number;
  y: number;
  /** Radians; 0 points right, the way the brand mark faces. */
  angle: number;
  size: number;
  alpha: number;
  /** 0 = white (still a letter), 1 = its employee color. */
  toGroup: number;
  /** 0 = employee color, 1 = Colony violet (part of the logo). */
  toViolet: number;
};

export type SwarmOptions = {
  seed: number;
  releaseAt: number;
  sweep: number;
  frameWidth: number;
};

export function bezier(p0: Point, p1: Point, p2: Point, p3: Point, u: number): Point {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

export function bezierTangent(p0: Point, p1: Point, p2: Point, p3: Point, u: number): Point {
  const v = 1 - u;
  const a = 3 * v * v;
  const b = 6 * v * u;
  const c = 3 * u * u;
  return {
    x: a * (p1.x - p0.x) + b * (p2.x - p1.x) + c * (p3.x - p2.x),
    y: a * (p1.y - p0.y) + b * (p2.y - p1.y) + c * (p3.y - p2.y),
  };
}

/**
 * Pairs each letter point with a logo point and gives it a river. Ants are
 * split evenly across lanes; inside a lane, starts and ends are both sorted
 * by x and paired in order, so a river flows instead of tangling.
 */
export function createAnts(starts: Point[], ends: Point[], lanes: Lane[], opts: SwarmOptions): Ant[] {
  if (starts.length !== ends.length) {
    throw new Error(`createAnts: ${starts.length} starts but ${ends.length} ends`);
  }
  if (lanes.length === 0) throw new Error("createAnts: no lanes");
  const rand = mulberry32(opts.seed);
  const order = starts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const groups: number[][] = lanes.map(() => []);
  order.forEach((index, rank) => {
    groups[rank % lanes.length].push(index);
  });
  const ants: Ant[] = [];
  groups.forEach((members, group) => {
    const lane = lanes[group];
    const jitter = () => (rand() - 0.5) * 2 * lane.spread;
    const byStart = [...members].sort((a, b) => starts[a].x - starts[b].x);
    const byEnd = [...members].sort((a, b) => ends[a].x - ends[b].x);
    byStart.forEach((startIndex, k) => {
      const start = starts[startIndex];
      ants.push({
        start,
        end: ends[byEnd[k]],
        group,
        c1: { x: lane.c1.x + jitter(), y: lane.c1.y + jitter() },
        c2: { x: lane.c2.x + jitter(), y: lane.c2.y + jitter() },
        appear: opts.releaseAt - 0.15 + rand() * 0.05,
        release: opts.releaseAt + (start.x / opts.frameWidth) * opts.sweep + rand() * 0.12,
        duration: 1.45 + rand() * 0.4,
        wobbleAmp: 10 + rand() * 22,
        wobblePhase: rand() * Math.PI * 2,
        size: 12 + rand() * 5,
      });
    });
  });
  return ants;
}

/** Where one ant is at `t` seconds. Pure: no state, any order. */
export function antState(ant: Ant, t: number): AntState {
  const u = clamp01((t - ant.release) / ant.duration);
  const e = easeInOutCubic(u);
  const base = bezier(ant.start, ant.c1, ant.c2, ant.end, e);
  const tan = bezierTangent(ant.start, ant.c1, ant.c2, ant.end, e);
  const len = Math.hypot(tan.x, tan.y) || 1;
  const wobble = Math.sin(Math.PI * e) * ant.wobbleAmp * Math.sin(t * 7 + ant.wobblePhase);
  const heading = Math.atan2(tan.y, tan.x);
  const leaving = smoothstep(0, 0.08, u);
  const landing = smoothstep(0.82, 1, u);
  return {
    x: base.x + (-tan.y / len) * wobble,
    y: base.y + (tan.x / len) * wobble,
    angle: lerpAngle(lerpAngle(0, heading, leaving), 0, landing),
    size: ant.size * (0.62 + 0.38 * leaving) * (1 + 0.2 * landing),
    alpha: smoothstep(ant.appear, ant.appear + 0.15, t),
    toGroup: smoothstep(0, 0.25, u),
    toViolet: landing,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd video && pnpm test`
Expected: PASS, every test in `math`, `timeline`, `points` and `swarm`.

- [ ] **Step 5: Commit**

```bash
git add video/src/launch/swarm.ts video/src/launch/swarm.test.ts
git commit -s -m "video(launch): deterministic ant flight model with four colored rivers"
```

---

### Task 4: Canvas pieces: ant shape, words, fonts and target sampling

**Files:**
- Create: `video/src/launch/antShape.ts`, `video/src/launch/words.ts`, `video/src/launch/fonts.ts`, `video/src/launch/useAnts.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3.
- Produces: `MARK_W`, `MARK_H`, `antShapes(): AntShapes`, `drawAnt(ctx, shapes, x, y, angle, size, color, alpha)`, `drawMarkSilhouette(ctx, rect)`; `JOB_WORDS`, `drawWords(ctx, family, t, mode: "film" | "rest")`; `INTER`, `interReady`; `useAnts(): Ant[] | null`.

These pieces need a browser canvas, so they are verified by rendering in Task 6, not by Node tests. Review Focus 1 lives here: `useAnts` refuses to sample a fallback font.

- [ ] **Step 1: Write `antShape.ts`**

```ts
/**
 * The Colony ant mark as canvas paths. Geometry copied from
 * src/brand/AntMark.tsx (viewBox 0 0 466 309; source of truth docs/BRAND.md).
 * Keep the two in sync by hand.
 */
export const MARK_W = 466;
export const MARK_H = 309;
const LIMB_WIDTH = 14;

export type AntShapes = { body: Path2D; limbs: Path2D };

const BODY: ReadonlyArray<readonly [number, number, number]> = [
  [104, 172, 80],
  [226, 164, 52],
  [313, 148, 46],
];
const LEGS: ReadonlyArray<readonly [number, number, number, number]> = [
  [202, 203, 136, 292],
  [220, 210, 196, 298],
  [235, 209, 246, 300],
  [247, 205, 294, 294],
  [257, 198, 336, 282],
  [164, 215, 112, 272],
];

export function antShapes(): AntShapes {
  const body = new Path2D();
  for (const [cx, cy, r] of BODY) {
    body.moveTo(cx + r, cy);
    body.arc(cx, cy, r, 0, Math.PI * 2);
  }
  const limbs = new Path2D();
  for (const [x1, y1, x2, y2] of LEGS) {
    limbs.moveTo(x1, y1);
    limbs.lineTo(x2, y2);
  }
  limbs.moveTo(327, 114);
  limbs.quadraticCurveTo(345, 64, 397, 50);
  limbs.moveTo(343, 126);
  limbs.quadraticCurveTo(377, 86, 427, 80);
  return { body, limbs };
}

/** One ant centred on (x, y), `size` px long, nose along `angle`. Tiny ants skip the eye. */
export function drawAnt(
  ctx: CanvasRenderingContext2D,
  shapes: AntShapes,
  x: number,
  y: number,
  angle: number,
  size: number,
  color: string,
  alpha: number,
): void {
  const k = size / MARK_W;
  const cos = Math.cos(angle) * k;
  const sin = Math.sin(angle) * k;
  ctx.setTransform(cos, sin, -sin, cos, x, y);
  ctx.translate(-MARK_W / 2, -MARK_H / 2);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = LIMB_WIDTH;
  ctx.lineCap = "round";
  ctx.stroke(shapes.limbs);
  ctx.fill(shapes.body);
}

/** The whole mark, eye cut out, filling `rect`: the shape the swarm lands in. */
export function drawMarkSilhouette(
  ctx: CanvasRenderingContext2D,
  rect: { cx: number; cy: number; width: number; height: number },
): void {
  const shapes = antShapes();
  const k = rect.width / MARK_W;
  ctx.setTransform(k, 0, 0, k, rect.cx - rect.width / 2, rect.cy - rect.height / 2);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = LIMB_WIDTH;
  ctx.lineCap = "round";
  ctx.stroke(shapes.limbs);
  ctx.fill(shapes.body);
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(335, 136, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
```

- [ ] **Step 2: Write `fonts.ts`**

```ts
import { loadFont } from "@remotion/google-fonts/Inter";

const inter = loadFont("normal", { weights: ["600", "800"], subsets: ["latin"] });

/** The family name to use in CSS and canvas font strings. */
export const INTER = inter.fontFamily;
export const interReady: Promise<unknown> = inter.waitUntilDone();
```

- [ ] **Step 3: Write `words.ts`**

```ts
import { easeOutExpo, progress, smoothstep } from "./math.ts";
import { fitFontSize } from "./points.ts";
import { FRAME_W, TEXT_MAX_WIDTH, T_RELEASE, T_TREMBLE } from "./timeline.ts";

export type JobWord = { text: string; at: number };

/** The owner's to-do list. Not promises: only four of these are Colony employees. */
export const JOB_WORDS: JobWord[] = [
  { text: "Find customers", at: 0.08 },
  { text: "Post on Instagram", at: 0.34 },
  { text: "Reply to emails", at: 0.58 },
  { text: "Update the website", at: 0.8 },
  { text: "Send quotes", at: 1.0 },
  { text: "Chase invoices", at: 1.18 },
];

const DESIRED_SIZE = 116;
const LINE_STEP = 132;
const STACK_CENTER_Y = 960;
const TRACKING = -0.035;
const INK = "#f4f3f8";

function fontAt(family: string, size: number): string {
  return `800 ${size}px "${family}"`;
}

/**
 * Draws the job words at time `t`. "rest" draws every word fully landed,
 * sharp and opaque: the exact shapes the ants are sampled from.
 */
export function drawWords(
  ctx: CanvasRenderingContext2D,
  family: string,
  t: number,
  mode: "film" | "rest",
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = INK;
  const top = STACK_CENTER_Y - ((JOB_WORDS.length - 1) * LINE_STEP) / 2;
  const film = mode === "film";
  const fadeOut = film ? progress(t, T_RELEASE, 0.25) : 0;
  const tremble = film
    ? smoothstep(T_TREMBLE, T_TREMBLE + 0.25, t) * (1 - smoothstep(T_RELEASE - 0.12, T_RELEASE, t))
    : 0;
  JOB_WORDS.forEach((word, index) => {
    const size = fitFontSize(
      (s) => {
        ctx.font = fontAt(family, s);
        ctx.letterSpacing = `${TRACKING * s}px`;
        return ctx.measureText(word.text).width;
      },
      DESIRED_SIZE,
      TEXT_MAX_WIDTH,
    );
    const enter = film ? easeOutExpo(progress(t, word.at, 0.42)) : 1;
    if (enter <= 0) return;
    const newer = film ? JOB_WORDS.filter((w) => w.at > word.at && w.at + 0.2 <= t).length : 0;
    const alpha = film ? enter * Math.max(0.42, 1 - 0.12 * newer) * (1 - fadeOut) : 1;
    if (alpha <= 0) return;
    const blur = film ? (1 - enter) * 18 + fadeOut * 6 : 0;
    const scale = 1 + (1 - enter) * 0.08 + fadeOut * 0.04;
    const x = FRAME_W / 2 + tremble * 2.4 * Math.sin(t * 61 + index * 1.7);
    const y = top + index * LINE_STEP + (1 - enter) * 40 + tremble * 2.4 * Math.cos(t * 53 + index * 2.3);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.font = fontAt(family, size);
    ctx.letterSpacing = `${TRACKING * size}px`;
    ctx.fillText(word.text, 0, 0);
    ctx.restore();
  });
}
```

- [ ] **Step 4: Write `useAnts.ts`**

```ts
import { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender } from "remotion";
import { drawMarkSilhouette } from "./antShape";
import { INTER, interReady } from "./fonts";
import { mulberry32 } from "./math.ts";
import { pickPoints, sampleAlphaPoints } from "./points.ts";
import { type Ant, createAnts } from "./swarm.ts";
import {
  ANT_COUNT,
  FRAME_H,
  FRAME_W,
  LANES,
  LOGO_RECT,
  RELEASE_SWEEP,
  SEED,
  T_RELEASE,
} from "./timeline.ts";
import { drawWords } from "./words";

function rasterAlpha(draw: (ctx: CanvasRenderingContext2D) => void): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_W;
  canvas.height = FRAME_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  draw(ctx);
  return ctx.getImageData(0, 0, FRAME_W, FRAME_H).data;
}

/**
 * Samples the letters and the logo once per render tab, after Inter has
 * loaded, and builds the swarm. Holds the frame until it is ready.
 */
export function useAnts(): Ant[] | null {
  const [handle] = useState(() => delayRender("Sampling swarm target points"));
  const [ants, setAnts] = useState<Ant[] | null>(null);
  useEffect(() => {
    let live = true;
    interReady
      .then(() => {
        if (!document.fonts.check(`800 100px "${INTER}"`)) {
          throw new Error("Inter 800 is not loaded; refusing to sample a fallback font");
        }
        const rand = mulberry32(SEED);
        const letters = sampleAlphaPoints(
          rasterAlpha((ctx) => drawWords(ctx, INTER, T_RELEASE, "rest")),
          FRAME_W,
          FRAME_H,
          5,
        );
        const logo = sampleAlphaPoints(
          rasterAlpha((ctx) => drawMarkSilhouette(ctx, LOGO_RECT)),
          FRAME_W,
          FRAME_H,
          6,
        );
        const built = createAnts(
          pickPoints(letters, ANT_COUNT, rand),
          pickPoints(logo, ANT_COUNT, rand),
          LANES,
          { seed: SEED + 1, releaseAt: T_RELEASE, sweep: RELEASE_SWEEP, frameWidth: FRAME_W },
        );
        if (live) {
          setAnts(built);
          continueRender(handle);
        }
      })
      .catch((err: unknown) => cancelRender(err));
    return () => {
      live = false;
    };
  }, [handle]);
  return ants;
}
```

- [ ] **Step 5: Type-check and lint**

Run: `cd video && pnpm exec biome check --write src/launch && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add video/src/launch/antShape.ts video/src/launch/fonts.ts video/src/launch/words.ts video/src/launch/useAnts.ts
git commit -s -m "video(launch): canvas ant mark, job words and swarm target sampling"
```

---

### Task 5: Layers and the LaunchProof composition

**Files:**
- Create: `video/src/launch/SwarmLayer.tsx`, `video/src/launch/LogoReveal.tsx`, `video/src/launch/Backdrop.tsx`, `video/src/launch/LaunchProof.tsx`
- Modify: `video/src/Root.tsx` (register two compositions), `video/package.json` (render scripts)

**Interfaces:**
- Consumes: Tasks 1 to 4, `AntMark` from `src/brand/AntMark.tsx`.
- Produces: compositions `LaunchProof` (30 fps, 180 frames) and `LaunchProof60` (60 fps, 360 frames), both 1080 by 1920.

- [ ] **Step 1: Write `SwarmLayer.tsx`**

```tsx
import { useLayoutEffect, useMemo, useRef } from "react";
import { antShapes, drawAnt } from "./antShape";
import { antColor } from "./colors.ts";
import { progress } from "./math.ts";
import { type Ant, antState } from "./swarm.ts";
import { FRAME_H, FRAME_W, T_LOGO_IN } from "./timeline.ts";

/** Motion trail: earlier positions, seconds apart, fading out. */
const TRAIL_DT = 0.022;
const TRAIL_ALPHA = [1, 0.42, 0.22, 0.1];

const layer: React.CSSProperties = {
  position: "absolute",
  left: 0,
  top: 0,
  width: FRAME_W,
  height: FRAME_H,
};

export const SwarmLayer: React.FC<{ ants: Ant[]; t: number }> = ({ ants, t }) => {
  const sharpRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  const shapes = useMemo(() => antShapes(), []);
  useLayoutEffect(() => {
    const sharpCanvas = sharpRef.current;
    const sharp = sharpCanvas?.getContext("2d");
    const glow = glowRef.current?.getContext("2d");
    if (!sharpCanvas || !sharp || !glow) return;
    sharp.setTransform(1, 0, 0, 1, 0, 0);
    sharp.globalAlpha = 1;
    sharp.clearRect(0, 0, FRAME_W, FRAME_H);
    // Once the crisp logo arrives, the swarm fades to a faint halo under it.
    const settle = 1 - 0.85 * progress(t, T_LOGO_IN, 0.45);
    for (let k = TRAIL_ALPHA.length - 1; k >= 0; k--) {
      const tk = t - k * TRAIL_DT;
      for (const ant of ants) {
        if (k > 0 && tk < ant.release) continue;
        const s = antState(ant, tk);
        const alpha = s.alpha * TRAIL_ALPHA[k] * settle;
        if (alpha <= 0.004) continue;
        drawAnt(
          sharp,
          shapes,
          s.x,
          s.y,
          s.angle,
          s.size * (1 - 0.12 * k),
          antColor(ant.group, s.toGroup, s.toViolet),
          alpha,
        );
      }
    }
    glow.setTransform(1, 0, 0, 1, 0, 0);
    glow.globalAlpha = 1;
    glow.clearRect(0, 0, FRAME_W, FRAME_H);
    glow.drawImage(sharpCanvas, 0, 0);
  }, [ants, shapes, t]);
  return (
    <>
      <canvas
        ref={glowRef}
        width={FRAME_W}
        height={FRAME_H}
        style={{ ...layer, filter: "blur(18px) saturate(1.5)", opacity: 0.9, mixBlendMode: "screen" }}
      />
      <canvas ref={sharpRef} width={FRAME_W} height={FRAME_H} style={layer} />
    </>
  );
};
```

- [ ] **Step 2: Write `LogoReveal.tsx`**

```tsx
import { AntMark } from "../brand/AntMark";
import { INTER } from "./fonts";
import { easeOutExpo, progress, smoothstep } from "./math.ts";
import { LOGO_RECT, T_LOGO_IN, T_TEXT_1, T_TEXT_2 } from "./timeline.ts";

const VIOLET = "hsl(258 90% 66%)";

function reveal(t: number, at: number): React.CSSProperties {
  const e = easeOutExpo(progress(t, at, 0.7));
  return {
    opacity: e,
    transform: `translateY(${((1 - e) * 34).toFixed(2)}px)`,
    filter: `blur(${((1 - e) * 10).toFixed(2)}px)`,
  };
}

/** The crisp brand mark taking over from the swarm, a light pulse, and "Introducing Colony." */
export const LogoReveal: React.FC<{ t: number }> = ({ t }) => {
  const logoIn = smoothstep(T_LOGO_IN, T_LOGO_IN + 0.4, t);
  const pulse = progress(t, T_LOGO_IN + 0.05, 1.1);
  const ring = easeOutExpo(pulse);
  const glow =
    0.55 * Math.sin(Math.PI * Math.min(1, pulse * 1.4)) +
    0.22 * smoothstep(T_LOGO_IN, T_LOGO_IN + 0.6, t);
  const ringAlpha = pulse > 0 ? 0.45 * (1 - ring) : 0;
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: LOGO_RECT.cx - 520,
          top: LOGO_RECT.cy - 520,
          width: 1040,
          height: 1040,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, hsl(258 90% 66% / 0.55) 0%, hsl(258 90% 66% / 0.12) 38%, transparent 70%)",
          opacity: glow,
          transform: `scale(${(0.7 + 0.35 * ring).toFixed(4)})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: LOGO_RECT.cx - 300,
          top: LOGO_RECT.cy - 300,
          width: 600,
          height: 600,
          borderRadius: "50%",
          border: `3px solid hsl(258 90% 76% / ${ringAlpha.toFixed(3)})`,
          transform: `scale(${(0.6 + 1.1 * ring).toFixed(4)})`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: LOGO_RECT.cx - LOGO_RECT.width / 2,
          top: LOGO_RECT.cy - LOGO_RECT.height / 2,
          width: LOGO_RECT.width,
          height: LOGO_RECT.height,
          color: VIOLET,
          opacity: logoIn,
          filter: `drop-shadow(0 0 ${(24 * logoIn).toFixed(1)}px hsl(258 90% 66% / 0.6))`,
        }}
      >
        <AntMark />
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: LOGO_RECT.cy + LOGO_RECT.height / 2 + 70,
          textAlign: "center",
          fontFamily: INTER,
        }}
      >
        <div
          style={{
            fontSize: 50,
            fontWeight: 600,
            color: "rgb(236 235 243 / 0.72)",
            letterSpacing: "0.01em",
            ...reveal(t, T_TEXT_1),
          }}
        >
          Introducing
        </div>
        <div
          style={{
            fontSize: 150,
            fontWeight: 800,
            color: "#fff",
            letterSpacing: "-0.045em",
            lineHeight: 1.05,
            marginTop: 6,
            ...reveal(t, T_TEXT_2),
          }}
        >
          Colony.
        </div>
      </div>
    </>
  );
};
```

- [ ] **Step 3: Write `Backdrop.tsx`**

```tsx
import { useLayoutEffect, useRef } from "react";
import { mulberry32 } from "./math.ts";
import { FRAME_H, FRAME_W } from "./timeline.ts";

const GRAIN_W = 540;
const GRAIN_H = 960;

/** Near black with a hint of violet, never flat black. */
export const Backdrop: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: "radial-gradient(120% 75% at 50% 42%, #1a142b 0%, #0d0b15 52%, #060509 100%)",
    }}
  />
);

export const Vignette: React.FC = () => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      background: "radial-gradient(110% 70% at 50% 45%, transparent 55%, rgb(0 0 0 / 0.55) 100%)",
    }}
  />
);

/** Film grain that changes 24 times a second whatever the frame rate. */
export const Grain: React.FC<{ t: number }> = ({ t }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const tick = Math.floor(t * 24);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(GRAIN_W, GRAIN_H);
    const rand = mulberry32(9001 + tick);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.floor(rand() * 256);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [tick]);
  return (
    <canvas
      ref={ref}
      width={GRAIN_W}
      height={GRAIN_H}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: FRAME_W,
        height: FRAME_H,
        opacity: 0.075,
        mixBlendMode: "overlay",
      }}
    />
  );
};
```

- [ ] **Step 4: Write `LaunchProof.tsx`**

```tsx
import { useLayoutEffect, useRef } from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { AntMark } from "../brand/AntMark";
import { Backdrop, Grain, Vignette } from "./Backdrop";
import { INTER } from "./fonts";
import { LogoReveal } from "./LogoReveal";
import { easeInOutCubic, progress, smoothstep } from "./math.ts";
import { SwarmLayer } from "./SwarmLayer";
import { FRAME_H, FRAME_W, PROOF_SECONDS, T_LOGO_IN, timeAt } from "./timeline.ts";
import { useAnts } from "./useAnts";
import { drawWords } from "./words";

const WordsLayer: React.FC<{ t: number }> = ({ t }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, FRAME_W, FRAME_H);
    drawWords(ctx, INTER, t, "film");
  }, [t]);
  return (
    <canvas
      ref={ref}
      width={FRAME_W}
      height={FRAME_H}
      style={{ position: "absolute", left: 0, top: 0, width: FRAME_W, height: FRAME_H }}
    />
  );
};

/** The single glowing ant the film opens on; the words burst out around it. */
const SoloAnt: React.FC<{ t: number }> = ({ t }) => {
  const fade = 1 - smoothstep(0.3, 0.7, t);
  if (fade <= 0) return null;
  const breathe = 1 + 0.06 * Math.sin(t * 6);
  return (
    <div
      style={{
        position: "absolute",
        left: FRAME_W / 2 - 48,
        top: FRAME_H / 2 - 32,
        width: 96,
        height: 64,
        color: "#f4f3f8",
        opacity: fade,
        transform: `scale(${breathe.toFixed(4)})`,
        filter: "drop-shadow(0 0 18px hsl(258 90% 76% / 0.9))",
      }}
    >
      <AntMark />
    </div>
  );
};

export const LaunchProof: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = timeAt(frame, fps);
  const ants = useAnts();
  const push = 1 + 0.045 * easeInOutCubic(t / PROOF_SECONDS);
  const punch = 1 + 0.018 * Math.sin(Math.PI * progress(t, T_LOGO_IN, 0.5));
  return (
    <AbsoluteFill style={{ backgroundColor: "#060509" }}>
      <Backdrop />
      <AbsoluteFill style={{ transform: `scale(${(push * punch).toFixed(5)})` }}>
        <SoloAnt t={t} />
        <WordsLayer t={t} />
        {ants ? <SwarmLayer ants={ants} t={t} /> : null}
        <LogoReveal t={t} />
      </AbsoluteFill>
      <Vignette />
      <Grain t={t} />
    </AbsoluteFill>
  );
};
```

- [ ] **Step 5: Register the compositions**

In `video/src/Root.tsx` add the import:

```tsx
import { LaunchProof } from "./launch/LaunchProof";
```

and inside the `Root` fragment, after the `T1` composition:

```tsx
      <Composition
        id="LaunchProof"
        component={LaunchProof}
        durationInFrames={180}
        fps={30}
        width={1080}
        height={1920}
      />
      <Composition
        id="LaunchProof60"
        component={LaunchProof}
        durationInFrames={360}
        fps={60}
        width={1080}
        height={1920}
      />
```

In `video/package.json` add to `scripts`:

```json
"render:proof": "remotion render src/index.ts LaunchProof out/launch-proof.mp4 --jpeg-quality=95 --crf=16",
"render:proof60": "remotion render src/index.ts LaunchProof60 out/launch-proof-60.mp4 --jpeg-quality=95 --crf=16",
"still:proof": "remotion still src/index.ts LaunchProof out/launch-proof-hero.png --frame=168",
```

- [ ] **Step 6: Type-check, lint and run the unit tests**

Run: `cd video && pnpm exec biome check --write src && pnpm exec tsc --noEmit && pnpm test`
Expected: no lint or type errors; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add video/src/launch video/src/Root.tsx video/package.json
git commit -s -m "video(launch): LaunchProof composition, words to swarm to logo"
```

---

### Task 6: Render, gate, and polish against the $10M bar

**Files:**
- Output only (gitignored): `video/out/launch-proof.mp4`, `video/out/launch-proof-60.mp4`, `video/out/launch-proof-hero.png`, `video/out/launch-proof-mid.png`, `video/out/launch-proof-sheet.png`
- Modify: any `video/src/launch/*` file the polish pass needs

- [ ] **Step 1: Render the hero still and a mid-flight still**

Run: `cd video && pnpm run still:proof && pnpm exec remotion still src/index.ts LaunchProof out/launch-proof-mid.png --frame=93`
Expected: two 1080 by 1920 PNGs.

- [ ] **Step 2: Determinism gate (Review Focus 2)**

Run: `cd video && pnpm exec remotion still src/index.ts LaunchProof out/launch-proof-hero-b.png --frame=168 && shasum -a 256 out/launch-proof-hero.png out/launch-proof-hero-b.png`
Expected: both hashes identical.

- [ ] **Step 3: Render both frame rates and time them**

Run: `cd video && time pnpm run render:proof && time pnpm run render:proof60`
Expected: two MP4s, 6.0 seconds each; note both render times.

- [ ] **Step 4: Brightness gate (Review Focus 5)**

Run:

```bash
cd video && ffmpeg -hide_banner -i out/launch-proof.mp4 -vf "fps=4,signalstats,metadata=print:key=lavfi.signalstats.YMAX" -f null - 2>&1 | grep -o "YMAX=[0-9]*" | awk -F= '{ if ($2 < 60) bad++ ; n++ } END { print n " frames sampled, " bad+0 " too dark" }'
```

Expected: `24 frames sampled, 0 too dark` (frame 0 included).

- [ ] **Step 5: Contact sheet for review**

Run: `cd video && ffmpeg -hide_banner -y -i out/launch-proof.mp4 -vf "fps=2,scale=270:-1,tile=6x2" -frames:v 1 out/launch-proof-sheet.png`
Expected: one PNG with 12 frames across the 6 seconds.

- [ ] **Step 6: Self-review against the bar, then polish**

Open the hero still, the mid-flight still and the contact sheet. Judge them as a motion designer at a funded studio would. List every concrete flaw (for example: rivers too thin to read, ants too small, glow muddy, type spacing loose, logo landing without impact, dead frames, banding in the gradient). Fix the worst flaws in `timeline.ts` constants (`ANT_COUNT`, `LANES`, times), `swarm.ts` numbers, or the layer styles, re-run the unit tests, and repeat Steps 1 to 5. Stop after the pass where no flaw remains that a stranger would notice, or after three passes, and write down what still falls short.

- [ ] **Step 7: Commit the polish**

```bash
git add video/src/launch
git commit -s -m "video(launch): polish the look proof"
```

---

### Task 7: Hand the proof to the owner

**Files:**
- Copy to: `~/Desktop/Colony video tests/` (the owner's existing review folder)

- [ ] **Step 1: Copy the deliverables with plain names**

```bash
cd video && cp out/launch-proof.mp4 "$HOME/Desktop/Colony video tests/08 launch look proof - 30fps.mp4" && cp out/launch-proof-60.mp4 "$HOME/Desktop/Colony video tests/09 launch look proof - 60fps.mp4" && cp out/launch-proof-hero.png "$HOME/Desktop/Colony video tests/10 launch look proof - hero still.png"
```

- [ ] **Step 2: Send them and report**

Send the hero still and the 30 fps MP4 with `SendUserFile`. Report in plain words: what the proof shows, both render times, the 30 versus 60 fps verdict, every gate result, and what was NOT verified (no sound, no app screens, not watched on a real phone).
