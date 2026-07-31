# Colony Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand consumer-facing surfaces from Buzz to Colony: ant mark + animations, landing, loading, strings, icons, docs, plus a new marketing site at colony.ainative.ventures.

**Architecture:** Port-and-swap. New `colony-logo/` components reproduce the existing animation architecture (compositor-safe HTML-layer transforms, CSS-only, reduced-motion fallbacks) with ant geometry. Consumers swap imports in place. The 722-line `BuzzLogoAnimation` morph engine is replaced by a small `ColonyLogoAnimation` that keeps the prop contract consumers actually use. Marketing site is a fresh Vite+React+Tailwind package in `site/`, deployed to Cloudflare Pages.

**Tech Stack:** React 19, Tailwind, Tauri 2, Playwright e2e, Vite, wrangler (Cloudflare Pages).

## Global Constraints

- Work in worktree `/Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/colony-rebrand`, branch `colony-rebrand`. Never touch `codex/chat-native-blocks-plan`.
- Every commit: `git commit -s` (DCO). Conventional prefixes.
- Palette (from spec, copy exactly): violet `hsl(258 90% 66%)`, blue `hsl(217 91% 60%)`, pink `hsl(330 81% 60%)`, amber `hsl(38 92% 50%)`, green `hsl(160 60% 45%)`.
- User-visible copy only. NEVER rename: `BUZZ_*` env vars, crate names, event kinds, protocol strings, URLs, code identifiers not shown to users, `xyz.block.buzz.app` bundle identifier.
- No em-dashes in any user-facing copy or docs. Use commas, colons, or regular dashes.
- Desktop text sizes: stock rem tokens only (`text-base`, `text-sm`, `text-2xs`...). No `text-[15px]` or arbitrary rem. CI guard `pnpm check:px-text` enforces.
- All animation transforms on HTML-level elements (divs wrapping SVGs), never on SVG children (WebKit compositor rule, see `FlappingBee.tsx` doc comment).
- Every animation has a `prefers-reduced-motion: reduce` fallback to a static state.
- Before git or hooks: `. ./bin/activate-hermit` in the worktree.
- Run all commands from the worktree root unless stated. Shell cwd resets between tool calls: use `cd <worktree> && <cmd>` in one command.

---

### Task 1: AntMark static component

**Files:**
- Create: `desktop/src/shared/ui/colony-logo/AntMark.tsx`
- Create: `desktop/src/shared/ui/colony-logo/palette.ts`

**Interfaces:**
- Produces: `AntMark({ className }: { className?: string })` static SVG, `viewBox="0 0 466 309"` (same aspect as BuzzMark so consumer width classes keep working), rendered in `currentColor`, root class `colony-mark`.
- Produces: `palette.ts` exports `COLONY_HUES: string[]` (5 HSL strings, violet first) and named consts `COLONY_VIOLET`, `COLONY_BLUE`, `COLONY_PINK`, `COLONY_AMBER`, `COLONY_GREEN`.

- [ ] **Step 1: Create palette.ts**

```ts
// desktop/src/shared/ui/colony-logo/palette.ts

/** Colony brand hues. Violet leads; the rest are accent hues used by the
 * landing scatter field and marketing surfaces. Values are the brand source
 * of truth (mirrored in docs/BRAND.md). */
export const COLONY_VIOLET = "hsl(258 90% 66%)";
export const COLONY_BLUE = "hsl(217 91% 60%)";
export const COLONY_PINK = "hsl(330 81% 60%)";
export const COLONY_AMBER = "hsl(38 92% 50%)";
export const COLONY_GREEN = "hsl(160 60% 45%)";

export const COLONY_HUES = [
  COLONY_VIOLET,
  COLONY_BLUE,
  COLONY_PINK,
  COLONY_AMBER,
  COLONY_GREEN,
];
```

- [ ] **Step 2: Create AntMark.tsx**

Geometric minimal ant, side profile facing right. Three-circle body, six stroke legs, two antennae, one eye cutout (mask, same technique as BuzzMark's cutouts). Legs and antennae are strokes with round caps; body paints over leg roots via DOM order.

```tsx
// desktop/src/shared/ui/colony-logo/AntMark.tsx
import { useId } from "react";

/**
 * The Colony ant mark as a plain static SVG. No SMIL, no scripting. Rendered
 * in `currentColor` so it tints per-theme, and it paints complete on the very
 * first frame regardless of animation support. Geometry is shared with
 * {@link WalkingAnt} (same viewBox and coordinates) so the static and
 * animated marks are pixel-identical at rest.
 */
export function AntMark({ className }: { className?: string }) {
  const maskId = `colony-mark-eye-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  return (
    <svg
      aria-hidden="true"
      className={["colony-mark", className].filter(Boolean).join(" ")}
      viewBox="0 0 466 309"
      fill="currentColor"
    >
      <defs>
        <mask
          id={maskId}
          x="-80"
          y="-80"
          width="626"
          height="469"
          maskUnits="userSpaceOnUse"
          maskContentUnits="userSpaceOnUse"
        >
          <rect x="-80" y="-80" width="626" height="469" fill="#fff" />
          <circle cx="352" cy="136" r="11" fill="#000" />
        </mask>
      </defs>
      {/* Legs: two tripods (a: front-right stance, b: back stance). Drawn
          first so the body covers the roots. */}
      <g
        className="colony-legs"
        fill="none"
        stroke="currentColor"
        strokeWidth="14"
        strokeLinecap="round"
      >
        <path d="M188 226 L136 292" />
        <path d="M216 234 L196 298" />
        <path d="M240 236 L246 300" />
        <path d="M262 233 L294 294" />
        <path d="M281 226 L336 282" />
        <path d="M172 220 L112 272" />
      </g>
      {/* Antennae */}
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="14"
        strokeLinecap="round"
      >
        <path d="M344 114 Q362 64 414 50" />
        <path d="M360 126 Q394 86 444 80" />
      </g>
      {/* Body: abdomen, thorax, head. Head carries the eye cutout. */}
      <g mask={`url(#${maskId})`}>
        <circle cx="104" cy="172" r="80" />
        <circle cx="226" cy="164" r="52" />
        <circle cx="330" cy="148" r="46" />
      </g>
    </svg>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/colony-rebrand && . ./bin/activate-hermit && pnpm -C desktop typecheck`
Expected: PASS (new files compile; nothing imports them yet).

- [ ] **Step 4: Visual smoke of the geometry**

Temporarily render it: in `desktop/src/app/App.tsx`, next to the existing `BuzzMark` import add `import { AntMark } from "@/shared/ui/colony-logo/AntMark";` and swap the boot gate's `<FlappingBee className="relative z-10 h-auto w-28" />` for `<AntMark className="relative z-10 h-auto w-28" />`. Then:

Run: `cd <worktree>/desktop && pnpm build:e2e && node scripts/screenshot.mjs --name ant-mark-smoke || just desktop-screenshot --name ant-mark-smoke`
(From repo root the supported path is `just desktop-screenshot --name ant-mark-smoke`.)
Expected: PNG shows a legible ant silhouette. Check it at full size and squint at 32px. If proportions look wrong, adjust circle radii/leg endpoints, not the architecture. **Revert the App.tsx edit after capturing.**

- [ ] **Step 5: Commit**

```bash
cd /Users/mac/Desktop/Billion/AI-Native-Ventures-App-worktrees/colony-rebrand && . ./bin/activate-hermit && \
git add desktop/src/shared/ui/colony-logo/ && \
git commit -s -m "feat(desktop): add Colony AntMark and brand palette"
```

---

### Task 2: WalkingAnt animated component

**Files:**
- Create: `desktop/src/shared/ui/colony-logo/WalkingAnt.tsx`
- Modify: `desktop/src/shared/styles/globals/animations.css` (append Colony section; the bee section at lines ~852-918 stays until Task 4 removes the bee components)

**Interfaces:**
- Consumes: AntMark geometry coordinates from Task 1 (same viewBox and paths).
- Produces: `WalkingAnt({ className }: { className?: string })`, root classes `colony-mark ant-sprite`, `aspect-[466/309]` wrapper. Drop-in replacement anywhere `FlappingBee` was used.

- [ ] **Step 1: Create WalkingAnt.tsx**

Same layering trick as FlappingBee, documented in the file: leg tripods are HTML-level `<svg>` layers whose CSS transforms animate on the compositor, so the gait keeps moving while the main thread is busy during boot. The layers span the full mark box (`inset-0`), no masks needed: unlike the bee wings, ant legs never cross a cutout, and the body SVG paints over the leg roots by DOM order.

```tsx
// desktop/src/shared/ui/colony-logo/WalkingAnt.tsx
import { useId } from "react";

/**
 * The Colony ant mark with a walking-leg gait. Geometry is identical to the
 * static {@link AntMark}: same silhouette, rendered in `currentColor`.
 *
 * Each leg tripod is its own HTML-level `<svg>` layer and the gait animates
 * those elements' CSS transforms. This is deliberate: WebKit paints SVG
 * *children* on the main thread, so a transform animation on a `<path>`
 * freezes for as long as boot work (bundle eval, first React render) hogs the
 * thread, exactly the window in which the loading gate is on screen.
 * Transforms on HTML-level elements run on the compositor (Core Animation in
 * WKWebView) and keep stepping regardless.
 *
 * Everything is plain SVG + CSS (no JS/SMIL), so it paints on the very first
 * frame. Reduced motion falls back to the static stance via the CSS media
 * query (see animations.css, "Colony ant gait" section).
 */
export function WalkingAnt({ className }: { className?: string }) {
  const maskId = `walking-ant-eye-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const legLayer = "ant-leg-layer absolute inset-0";
  const legSvg = "block h-full w-full";
  const legStroke = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 14,
    strokeLinecap: "round" as const,
  };

  return (
    <div
      aria-hidden="true"
      className={[
        "colony-mark",
        "ant-sprite",
        "relative",
        "aspect-[466/309]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Tripod A: front, middle-back, rear-swing */}
      <div className={`${legLayer} ant-leg-layer-a`}>
        <svg
          aria-hidden="true"
          className={`${legSvg}`}
          viewBox="0 0 466 309"
        >
          <g {...legStroke}>
            <path d="M281 226 L336 282" />
            <path d="M216 234 L196 298" />
            <path d="M172 220 L112 272" />
          </g>
        </svg>
      </div>
      {/* Tripod B: mid-front, center, back */}
      <div className={`${legLayer} ant-leg-layer-b`}>
        <svg
          aria-hidden="true"
          className={`${legSvg}`}
          viewBox="0 0 466 309"
        >
          <g {...legStroke}>
            <path d="M262 233 L294 294" />
            <path d="M240 236 L246 300" />
            <path d="M188 226 L136 292" />
          </g>
        </svg>
      </div>
      {/* Body last in DOM order so it paints over the leg roots, plus the
          antennae, which bob with the body layer. */}
      <div className="ant-body-layer relative h-full w-full">
        <svg
          aria-hidden="true"
          className="block h-full w-full"
          viewBox="0 0 466 309"
          fill="currentColor"
        >
          <defs>
            <mask
              id={maskId}
              x="-80"
              y="-80"
              width="626"
              height="469"
              maskUnits="userSpaceOnUse"
              maskContentUnits="userSpaceOnUse"
            >
              <rect x="-80" y="-80" width="626" height="469" fill="#fff" />
              <circle cx="352" cy="136" r="11" fill="#000" />
            </mask>
          </defs>
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="14"
            strokeLinecap="round"
          >
            <path d="M344 114 Q362 64 414 50" />
            <path d="M360 126 Q394 86 444 80" />
          </g>
          <g mask={`url(#${maskId})`}>
            <circle cx="104" cy="172" r="80" />
            <circle cx="226" cy="164" r="52" />
            <circle cx="330" cy="148" r="46" />
          </g>
        </svg>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append gait keyframes to animations.css**

Append after the existing bee section:

```css
/* ── Colony ant gait ────────────────────────────────────────────────────
   Leg tripods are HTML-level layers (see WalkingAnt.tsx). Alternating
   tripod rotation reads as a walk cycle; the body layer bobs slightly out
   of phase. All transforms are on HTML elements so they run on the
   compositor even while the main thread is busy (same rationale as the
   bee wing layers above). */
.ant-sprite .ant-leg-layer {
  will-change: transform;
  transform-origin: 50% 72%;
  animation-duration: 0.42s;
  animation-iteration-count: infinite;
  animation-timing-function: ease-in-out;
}

.ant-sprite .ant-leg-layer-a {
  animation-name: ant-step-a;
}

.ant-sprite .ant-leg-layer-b {
  animation-name: ant-step-b;
}

.ant-sprite .ant-body-layer {
  will-change: transform;
  animation: ant-body-bob 0.42s ease-in-out infinite;
}

@keyframes ant-step-a {
  0%,
  100% {
    transform: rotate(0deg) translateY(0);
  }
  50% {
    transform: rotate(-5deg) translateY(-1.6%);
  }
}

@keyframes ant-step-b {
  0%,
  100% {
    transform: rotate(-5deg) translateY(-1.6%);
  }
  50% {
    transform: rotate(0deg) translateY(0);
  }
}

@keyframes ant-body-bob {
  0%,
  100% {
    transform: translateY(0);
  }
  25%,
  75% {
    transform: translateY(-1%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ant-sprite .ant-leg-layer,
  .ant-sprite .ant-body-layer {
    animation: none;
  }
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `cd <worktree> && . ./bin/activate-hermit && pnpm -C desktop typecheck && pnpm -C desktop check`
Expected: PASS.

- [ ] **Step 4: Verify gait live**

Same temporary swap technique as Task 1 Step 4, but with `<WalkingAnt className="relative z-10 h-auto w-28" />` in the boot gate. Run `just desktop-standalone` from the worktree and watch the boot gate: legs alternate, body bobs, no jank. Also toggle macOS System Settings > Accessibility > Display > Reduce motion and confirm the ant freezes in the static stance. **Revert the App.tsx edit.**

- [ ] **Step 5: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add desktop/src/shared/ui/colony-logo/WalkingAnt.tsx desktop/src/shared/styles/globals/animations.css && \
git commit -s -m "feat(desktop): add WalkingAnt compositor-safe gait animation"
```

---

### Task 3: ColonyLogoAnimation + FuzzyMark (FuzzyLogo replacement)

**Files:**
- Create: `desktop/src/shared/ui/colony-logo/ColonyLogoAnimation.tsx`
- Create: `desktop/src/shared/ui/colony-logo/colony-logo-animation.css`
- Create: `desktop/src/shared/ui/colony-logo/FuzzyMark.tsx`

**Interfaces:**
- Consumes: `AntMark` from Task 1.
- Produces: `FuzzyMark(props: FuzzyMarkProps)` where `FuzzyMarkProps = { fuzz?: boolean; className?: string; ariaLabel?: string; loop?: boolean; loopRestSeconds?: number; pulse?: boolean }`. Default `ariaLabel = "Colony logo"`, `fuzz = true`, `pulse = true`. This matches every prop the current consumers pass to `FuzzyLogo` (verified: App.tsx, TurnLivenessIndicator, AgentSessionTranscriptList). Spec note: the spec table called this `ColonyWordmark`, but `FuzzyLogo` is the fuzzy mark, not a wordmark, so the port keeps the honest name `FuzzyMark`.
- Produces: `ColonyLogoAnimation` (internal engine used by FuzzyMark; not exported for consumers in this phase).

- [ ] **Step 1: Create colony-logo-animation.css**

Port of `buzz-logo-animation.css` with colony class names and violet background token:

```css
.colony-logo {
  display: grid;
  place-items: center;
  inline-size: fit-content;
}

.colony-logo__mark {
  display: block;
  inline-size: min(466px, calc(100vw - 32px));
  block-size: auto;
  overflow: visible;
}

.colony-logo--compact {
  inline-size: 1.5rem;
}

.colony-logo--compact .colony-logo__mark {
  inline-size: 100%;
  block-size: auto;
  max-inline-size: 100%;
}

@keyframes colony-logo-pulse {
  0%,
  100% {
    opacity: 0.55;
  }
  50% {
    opacity: 1;
  }
}

.colony-logo--pulse .colony-logo__mark {
  animation: colony-logo-pulse 1.8s ease-in-out infinite;
}

@keyframes colony-logo-rest-loop {
  0%,
  80%,
  100% {
    opacity: 1;
  }
  85%,
  95% {
    opacity: 0;
  }
}

.colony-logo--rest-loop .colony-logo__mark {
  animation: colony-logo-rest-loop var(--colony-loop-duration, 4s) ease-in-out
    infinite;
}

@media (prefers-reduced-motion: reduce) {
  .colony-logo--pulse .colony-logo__mark,
  .colony-logo--rest-loop .colony-logo__mark {
    animation: none;
    opacity: 0.8;
  }
}
```

- [ ] **Step 2: Create ColonyLogoAnimation.tsx**

Small engine: renders `AntMark`, optionally wrapped in an SVG feTurbulence grain filter (the "fuzz" texture), with pulse or rest-window loop driven by the CSS above.

```tsx
// desktop/src/shared/ui/colony-logo/ColonyLogoAnimation.tsx
import { useId } from "react";

import { cn } from "@/shared/lib/cn";
import { AntMark } from "./AntMark";
import "./colony-logo-animation.css";

export type ColonyLogoAnimationProps = {
  ariaLabel?: string;
  className?: string;
  /** Apply the animated fractal-noise grain filter. */
  textured?: boolean;
  /** Loop with a rest window (mark hides briefly between plays). */
  loop?: boolean;
  loopRestSeconds?: number;
  pulse?: boolean;
};

/**
 * Colony's animated mark engine. Replaces the Buzz morph engine with a much
 * smaller composition: the static AntMark, an optional feTurbulence grain
 * texture, and CSS-driven pulse / rest-window loops. All opacity animation is
 * CSS-only, and reduced motion renders the crisp static mark.
 */
export default function ColonyLogoAnimation({
  ariaLabel = "Colony logo",
  className,
  textured = false,
  loop = false,
  loopRestSeconds = 0,
  pulse = false,
}: ColonyLogoAnimationProps) {
  const filterId = `colony-fuzz-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hasRestWindow = loop && loopRestSeconds > 0;
  const loopDuration = 3 + loopRestSeconds;

  return (
    <span
      aria-label={ariaLabel}
      className={cn(
        "colony-logo",
        pulse && "colony-logo--pulse",
        hasRestWindow && "colony-logo--rest-loop",
        className,
      )}
      role="img"
      style={
        hasRestWindow
          ? ({
              "--colony-loop-duration": `${loopDuration}s`,
            } as React.CSSProperties)
          : undefined
      }
    >
      {textured ? (
        <span
          className="colony-logo__mark"
          style={{ filter: `url(#${filterId})` }}
        >
          <svg aria-hidden="true" className="absolute h-0 w-0">
            <defs>
              <filter id={filterId}>
                <feTurbulence
                  baseFrequency="0.9"
                  numOctaves="2"
                  result="noise"
                  type="fractalNoise"
                >
                  <animate
                    attributeName="seed"
                    dur="0.6s"
                    repeatCount="indefinite"
                    values="1;2;3;4;5;1"
                  />
                </feTurbulence>
                <feDisplacementMap in="SourceGraphic" in2="noise" scale="6" />
              </filter>
            </defs>
          </svg>
          <AntMark className="h-auto w-full" />
        </span>
      ) : (
        <span className="colony-logo__mark">
          <AntMark className="h-auto w-full" />
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 3: Create FuzzyMark.tsx**

```tsx
// desktop/src/shared/ui/colony-logo/FuzzyMark.tsx
import ColonyLogoAnimation from "./ColonyLogoAnimation";

export type FuzzyMarkProps = {
  /** When false, skips the looping feTurbulence texture and uses a CSS pulse instead. */
  fuzz?: boolean;
  className?: string;
  ariaLabel?: string;
  loop?: boolean;
  /** When looping, hide the mark for this many seconds between plays. */
  loopRestSeconds?: number;
  /** Set false when a parent drives its own opacity animation over the mark. */
  pulse?: boolean;
};

/**
 * The fuzzy Colony mark. Set `fuzz={false}` to render the crisp geometry with
 * a lightweight CSS pulse, recommended for long-lived mounts.
 */
export function FuzzyMark({
  fuzz = true,
  className,
  ariaLabel = "Colony logo",
  loop = false,
  loopRestSeconds = 0,
  pulse = true,
}: FuzzyMarkProps) {
  const hasRestWindow = loop && loopRestSeconds > 0;

  return (
    <ColonyLogoAnimation
      ariaLabel={ariaLabel}
      className={className}
      loop={loop}
      loopRestSeconds={loopRestSeconds}
      pulse={pulse && !fuzz && !hasRestWindow}
      textured={fuzz}
    />
  );
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `cd <worktree> && . ./bin/activate-hermit && pnpm -C desktop typecheck && pnpm -C desktop check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add desktop/src/shared/ui/colony-logo/ && \
git commit -s -m "feat(desktop): add ColonyLogoAnimation engine and FuzzyMark"
```

---

### Task 4: Swap all consumers, delete buzz-logo

**Files:**
- Modify: `desktop/src/app/App.tsx` (lines ~67-69, ~149-150, ~175)
- Modify: `desktop/src/features/onboarding/ui/OnboardingChrome.tsx` (lines 1, 56)
- Modify: `desktop/src/features/onboarding/ui/SetupStep.tsx` (lines 17, 581)
- Modify: `desktop/src/features/onboarding/ui/PendingInviteGate.tsx` (lines 4, 26)
- Modify: `desktop/src/features/onboarding/ui/RuntimeIcon.tsx` (lines 6, 61)
- Modify: `desktop/src/features/agents/ui/TurnLivenessIndicator.tsx` (lines 4, 31, 64)
- Modify: `desktop/src/features/agents/ui/AgentSessionTranscriptList.tsx` (lines 26, 211)
- Modify: `desktop/src/features/communities/ui/HostedCommunityOnboarding.tsx` (lines 35, 477)
- Delete: `desktop/src/shared/ui/buzz-logo/` (whole directory)
- Modify: `desktop/src/shared/styles/globals/animations.css` (remove the bee section: `.bee-sprite`, `.bee-wing*` rules and `bee-wing-*-flap` keyframes, ~lines 852-918)

**Interfaces:**
- Consumes: `AntMark`, `WalkingAnt`, `FuzzyMark` from Tasks 1-3.
- Produces: zero imports of `buzz-logo` anywhere in `desktop/src`.

- [ ] **Step 1: Swap imports and JSX mechanically**

Rules, applied to each file listed above:
- `import { BuzzMark } from "@/shared/ui/buzz-logo/BuzzMark"` -> `import { AntMark } from "@/shared/ui/colony-logo/AntMark"`; `<BuzzMark` -> `<AntMark`.
- `import { FlappingBee } from "@/shared/ui/buzz-logo/FlappingBee"` -> `import { WalkingAnt } from "@/shared/ui/colony-logo/WalkingAnt"`; `<FlappingBee` -> `<WalkingAnt`.
- `import { FuzzyLogo } from "@/shared/ui/buzz-logo/FuzzyLogo"` -> `import { FuzzyMark } from "@/shared/ui/colony-logo/FuzzyMark"`; `<FuzzyLogo` -> `<FuzzyMark`. Any `ariaLabel="Buzz logo"` becomes `ariaLabel="Colony logo"`.
- Props passed through unchanged otherwise (they are contract-compatible by Task 3).
- In App.tsx also update the boot-gate comment ("centered Buzz bee" -> "centered Colony ant, legs walking").

- [ ] **Step 2: Delete the bee**

```bash
cd <worktree> && git rm -r desktop/src/shared/ui/buzz-logo
```
Also remove the bee CSS block from `animations.css` (the section between the `.bee-sprite .bee-wing` rule and the closing of its reduced-motion block; keep the Colony section added in Task 2).

- [ ] **Step 3: Verify nothing references the bee**

Run: `cd <worktree> && grep -rn "buzz-logo\|BuzzMark\|FlappingBee\|FuzzyLogo\|BuzzLogoAnimation\|bee-sprite\|bee-wing" desktop/src ; echo "exit: $?"`
Expected: no matches (exit 1).

- [ ] **Step 4: Typecheck, lint, unit tests, build**

Run: `cd <worktree> && . ./bin/activate-hermit && pnpm -C desktop typecheck && pnpm -C desktop check && just desktop-test && just desktop-build`
Expected: all PASS. If a test references removed components, update it in this task.

- [ ] **Step 5: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add -A desktop/src && \
git commit -s -m "feat(desktop): swap all brand consumers to Colony ant components"
```

---

### Task 5: LandingAnts scatter field

**Files:**
- Create: `desktop/src/features/onboarding/ui/LandingAnts.tsx`
- Modify: whichever file renders `<LandingBees />` (find with `grep -rn "LandingBees" desktop/src`)
- Delete: `desktop/src/features/onboarding/ui/LandingBees.tsx`

**Interfaces:**
- Consumes: `AntMark`, `WalkingAnt` from Tasks 1-2, `COLONY_HUES` from Task 1.
- Produces: `LandingAnts()` with the exact same DOM contract as `LandingBees` (absolutely positioned, `pointer-events-none`, `aria-hidden` backdrop).

- [ ] **Step 1: Create LandingAnts.tsx**

Port of LandingBees: same fixed scatter (no per-render shimmer), same wander + pointer-repel rAF loop, same reduced-motion gate. Colors cycle through the five Colony hues instead of white/yellow. Copy the wander/repel effect body from LandingBees verbatim (it is being deleted, so no duplication remains), renaming `BEES` -> `ANTS`, `beeRefs` -> `antRefs`, `bee` -> `ant`. The scatter table keeps the same 27 positions/sizes/rotations but replaces the `color` column:

```tsx
// Top of file:
import * as React from "react";

import { AntMark } from "@/shared/ui/colony-logo/AntMark";
import { WalkingAnt } from "@/shared/ui/colony-logo/WalkingAnt";
import { COLONY_HUES } from "@/shared/ui/colony-logo/palette";

type Ant = {
  top: string;
  left: string;
  size: number;
  rotate: number;
  color: string;
};

// Fixed scatter so the field doesn't shimmer between renders. Positions,
// sizes, and rotations carry over from the Buzz landing field; hues cycle
// through the Colony palette.
const ANTS: Ant[] = [
  { top: "4%", left: "27%", size: 34, rotate: -12, color: COLONY_HUES[0] },
  { top: "7%", left: "58%", size: 28, rotate: 18, color: COLONY_HUES[1] },
  { top: "5%", left: "88%", size: 32, rotate: -20, color: COLONY_HUES[2] },
  // ...continue the pattern for all 27 rows of the original BEES table,
  // color: COLONY_HUES[i % 5] for row index i. Copy top/left/size/rotate
  // values from LandingBees.tsx rows 1:1 before deleting it.
];
```

The render body mirrors LandingBees: corner mark becomes `<AntMark className="h-auto w-full" />` with class `text-foreground` replacing the hardcoded `text-[#231E1E]`, and each scatter item renders `<WalkingAnt className="w-full" />`.

- [ ] **Step 2: Swap the render site and delete LandingBees**

`grep -rn "LandingBees" desktop/src`, swap the import and JSX to `LandingAnts`, then `git rm desktop/src/features/onboarding/ui/LandingBees.tsx`.

- [ ] **Step 3: Verify**

Run: `cd <worktree> && grep -rn "LandingBees" desktop/src; echo "exit: $?"` -> no matches.
Run: `cd <worktree> && . ./bin/activate-hermit && pnpm -C desktop typecheck && pnpm -C desktop check`
Expected: PASS.

- [ ] **Step 4: Screenshot the landing**

Run: `cd <worktree> && just desktop-screenshot --name colony-landing`
Expected: onboarding landing with multi-color walking ants. Eyeball: hues distinct, field balanced, no overlap with copy.

- [ ] **Step 5: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add -A desktop/src && \
git commit -s -m "feat(desktop): replace landing bees with Colony ant scatter field"
```

---

### Task 6: User-visible strings sweep + e2e assertion updates

**Files:**
- Modify: user-visible strings across `desktop/src` (starting set from audit: `main.tsx`, `app/App.tsx`, `app/AppShell.tsx`, `features/settings/UpdateChecker.tsx`, `features/settings/ui/*` including `SendFeedbackDialog.tsx`, `ProfileSettingsCard.tsx`, `SignOutSection.tsx`, `MobilePairingCard.tsx`, `HostedCommunitiesSettingsCard.tsx`, `harnessCatalogCopy.ts`, `features/onboarding/welcome.ts`, `welcomeGuide.ts`, `communityOnboarding.tsx`, `features/home/ui/InboxDetailPane.tsx`, `ProjectInboxDetailPane.tsx`, `features/home/lib/inbox.ts`)
- Modify: `desktop/tests/e2e/*.spec.ts` (50 "Buzz" assertions across ~10 files, list via grep in Step 3)

**Interfaces:**
- Produces: every user-visible "Buzz" replaced by "Colony"; protocol/env/internal names untouched.

- [ ] **Step 1: Build the audit list**

Run: `cd <worktree> && grep -rn "Buzz" desktop/src --include="*.ts" --include="*.tsx" | grep -v "BUZZ_" > /tmp/buzz-audit.txt && wc -l /tmp/buzz-audit.txt`

- [ ] **Step 2: Apply the decision rules line by line**

For each hit, classify and act:

| Pattern | Action |
|---|---|
| JSX text, `title=`, `aria-label=`, placeholder, toast/dialog copy, onboarding copy ("Welcome to Buzz") | Replace Buzz -> Colony |
| `BUZZ_*` env var names, `buzz://` deep-link scheme, `buzz-cli` command strings, kind names, relay protocol strings | Keep |
| URLs (github.com/block/buzz, buzz.xyz hosts) | Keep |
| Code identifiers not rendered (variable names, testids like `buzz-setup-loading-shell`) | Keep this phase (testids rename in technical phase; renaming them now churns e2e for zero user value) |
| Comments mentioning Buzz | Keep (not user-visible) |
| "Buzz relay" in user-facing error copy | Replace with "Colony relay" |

Notable specifics: UpdateChecker copy ("Buzz is up to date" and similar) -> Colony; SendFeedbackDialog copy -> Colony; `welcome.ts` / `welcomeGuide.ts` onboarding copy -> Colony; window/menu strings follow productName in Task 7, no code change here.

- [ ] **Step 3: Update e2e assertions**

Run: `cd <worktree> && grep -rln "Buzz" desktop/tests/e2e`
For each spec, update only assertions that assert *copy we changed* (e.g. `getByText("Welcome to Buzz")`). Assertions on testids or protocol fixtures stay.

- [ ] **Step 4: Verify sweep completeness**

Run: `cd <worktree> && grep -rn "Buzz" desktop/src --include="*.tsx" | grep -viE "BUZZ_|buzz://|github.com|buzz-cli|data-testid|className|//|/\*|\* " | head -40`
Expected: remaining hits are all Keep-classified. Spot-check each.

- [ ] **Step 5: Test + build**

Run: `cd <worktree> && . ./bin/activate-hermit && just desktop-test && cd desktop && pnpm test:e2e:smoke`
Expected: PASS. (`pnpm test:e2e:smoke` runs the e2e build itself; never a plain `pnpm run build` for e2e.)

- [ ] **Step 6: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add -A desktop && \
git commit -s -m "feat(desktop): rebrand user-visible copy from Buzz to Colony"
```

---

### Task 7: App icons, product name, DMG background

**Files:**
- Create: `desktop/src-tauri/icons/colony-source.svg` (1024x1024 icon artwork)
- Create: `scripts/render-brand-png.mjs` (SVG -> PNG via Playwright, reused for OG image in Task 10)
- Modify: `desktop/src-tauri/tauri.conf.json` (`productName`)
- Regenerate: `desktop/src-tauri/icons/*` (32x32.png, 128x128.png, 128x128@2x.png, icon.icns, icon.ico via `tauri icon`)
- Replace: `desktop/src-tauri/icons/dmg-background.png`
- Delete: `desktop/src-tauri/icons/buzz-source.png`

**Interfaces:**
- Consumes: AntMark geometry (inlined into icon SVG at icon-friendly weight).
- Produces: `scripts/render-brand-png.mjs <in.svg> <out.png> <width> <height>`.

- [ ] **Step 1: Create colony-source.svg**

Icon variant of the mark: ant centered on a violet rounded square, strokes thickened (strokeWidth 22 instead of 14) so legs survive 32px. White ant on `hsl(258 90% 66%)`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="224" fill="hsl(258 90% 66%)"/>
  <g transform="translate(279 358) scale(1)" fill="#fff">
    <g fill="none" stroke="#fff" stroke-width="22" stroke-linecap="round">
      <path d="M188 226 L136 292"/>
      <path d="M216 234 L196 298"/>
      <path d="M240 236 L246 300"/>
      <path d="M262 233 L294 294"/>
      <path d="M281 226 L336 282"/>
      <path d="M172 220 L112 272"/>
      <path d="M344 114 Q362 64 414 50"/>
      <path d="M360 126 Q394 86 444 80"/>
    </g>
    <circle cx="104" cy="172" r="80"/>
    <circle cx="226" cy="164" r="52"/>
    <circle cx="330" cy="148" r="46"/>
  </g>
</svg>
```
(Scale/translate centers the 466x309 mark in the 1024 box; adjust translate values so the ant is optically centered after first render.)

- [ ] **Step 2: Create scripts/render-brand-png.mjs**

```js
// Render an SVG file to PNG at an exact size using Playwright's Chromium.
// Usage: node scripts/render-brand-png.mjs in.svg out.png 1024 1024
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const [svgPath, outPath, w, h] = process.argv.slice(2);
if (!svgPath || !outPath || !w || !h) {
  console.error("usage: render-brand-png.mjs <in.svg> <out.png> <w> <h>");
  process.exit(1);
}
const svg = readFileSync(resolve(svgPath), "utf8");
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: Number(w), height: Number(h) },
  deviceScaleFactor: 1,
});
await page.setContent(
  `<style>*{margin:0}svg{display:block;width:${w}px;height:${h}px}</style>${svg}`,
);
await page.screenshot({ path: resolve(outPath), omitBackground: true });
await browser.close();
console.log(outPath);
```

- [ ] **Step 3: Generate the icon set**

```bash
cd <worktree> && . ./bin/activate-hermit && \
node scripts/render-brand-png.mjs desktop/src-tauri/icons/colony-source.svg /tmp/colony-icon-1024.png 1024 1024 && \
cd desktop && pnpm exec tauri icon /tmp/colony-icon-1024.png -o src-tauri/icons
```
Then confirm `tauri.conf.json`'s five icon paths all exist and are regenerated (`git status` shows them modified). `tauri icon` may emit extra platform sizes; keep only what the conf lists plus any it previously had.

- [ ] **Step 4: DMG background**

Create `desktop/src-tauri/icons/dmg-background.svg` (660x532 artboard, dark surface, AntMark at the app-icon position x=191 y=330, subtle five-hue accent dots), render it:
`node scripts/render-brand-png.mjs desktop/src-tauri/icons/dmg-background.svg desktop/src-tauri/icons/dmg-background.png 660 532`

- [ ] **Step 5: productName + delete bee source**

In `desktop/src-tauri/tauri.conf.json`: `"productName": "Buzz"` -> `"productName": "Colony"`. Then `git rm desktop/src-tauri/icons/buzz-source.png`.

- [ ] **Step 6: Build the app and verify**

Run: `cd <worktree> && . ./bin/activate-hermit && just desktop-build && just desktop-tauri-check`
Expected: PASS. Launch via `just desktop-standalone`: dock icon is the ant, macOS menu bar reads "Colony".
Note: `just desktop-tauri-fmt` fails in worktrees (gotcha #6); if pre-commit trips on it, run `just desktop-tauri-fmt` from the main checkout, restage, commit.

- [ ] **Step 7: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add -A desktop/src-tauri scripts/render-brand-png.mjs && \
git commit -s -m "feat(desktop): Colony app icons, product name, and DMG background"
```

---

### Task 8: Docs: README, BRAND.md, CHANGELOG

**Files:**
- Modify: `README.md` (top/branding section only)
- Create: `docs/BRAND.md`
- Modify: `CHANGELOG.md` (add unreleased entry)

**Interfaces:**
- Produces: `docs/BRAND.md` as the single source of truth for the later mobile/web rebrands.

- [ ] **Step 1: README top section**

Replace the title/intro branding with Colony, keep all technical content accurate. Include: product name "Colony", one-line description ("Colony is a company workspace where AI agents and people work together"), link to https://colony.ainative.ventures, and the lineage line: "Colony is built on Buzz, the open-source relay and app platform from Block." Do not change setup instructions, crate references, or `BUZZ_*` env docs.

- [ ] **Step 2: Write docs/BRAND.md**

```markdown
# Colony Brand

Single source of truth for Colony branding. Mobile and web clients copy from
here when they rebrand.

## Name

Colony. The desktop app is "Colony". Marketing domain:
https://colony.ainative.ventures

## Palette

Dark surfaces unchanged from the app theme. Brand hues:

| Token | Value | Use |
|---|---|---|
| violet (primary) | hsl(258 90% 66%) | Primary accent, icon background |
| blue | hsl(217 91% 60%) | Scatter/accent |
| pink | hsl(330 81% 60%) | Scatter/accent |
| amber | hsl(38 92% 50%) | Scatter/accent |
| green | hsl(160 60% 45%) | Scatter/accent |

Code: `desktop/src/shared/ui/colony-logo/palette.ts` (`COLONY_HUES`).

## Mark

Geometric minimal ant, side profile, `viewBox 0 0 466 309`, rendered in
`currentColor`. Components:

- `AntMark` static mark
- `WalkingAnt` animated gait (loading states)
- `FuzzyMark` textured/pulsing mark (liveness indicators)

Icon variant: white ant on violet rounded square
(`desktop/src-tauri/icons/colony-source.svg`), strokes thickened for small
sizes.

## Motion primitives

1. Walking ant: alternating leg-tripod gait, 0.42s cycle. Transforms live on
   HTML-level layers only (WebKit compositor rule; see WalkingAnt.tsx).
2. Pheromone trails: animated dashed SVG paths connecting points, used on the
   marketing site to show agents coordinating.
3. Scatter field: fixed-position multi-hue ants with pointer repel
   (`LandingAnts`).

Every animation has a `prefers-reduced-motion: reduce` fallback to a static
state. No em-dashes in user-facing copy.

## Do / Don't

- Do tint the mark with `currentColor` through theme tokens.
- Do keep the 466/309 aspect wherever the mark renders.
- Don't stretch, outline, or add gradients to the mark.
- Don't reintroduce bee assets; Buzz naming survives only in internals
  (env vars, crates, protocol) until the technical rename phase.
```

- [ ] **Step 3: CHANGELOG entry**

Add at top under an Unreleased heading: "Rebrand: the app is now Colony. New ant mark, landing, loading animations, icons, and marketing site. Internal names (crates, env vars, protocol) are unchanged."

- [ ] **Step 4: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add README.md docs/BRAND.md CHANGELOG.md && \
git commit -s -m "docs: rebrand README, add BRAND.md, changelog entry"
```

---

### Task 9: Marketing site scaffold (`site/`)

**Files:**
- Create: `site/package.json`, `site/vite.config.ts`, `site/tsconfig.json`, `site/index.html`, `site/tailwind.config.js`, `site/postcss.config.js`, `site/biome.json`, `site/src/main.tsx`, `site/src/App.tsx`, `site/src/styles.css`, `site/src/brand/AntMark.tsx`, `site/src/brand/WalkingAnt.tsx`, `site/src/brand/palette.ts`, `site/src/brand/site-animations.css`
- Modify: `pnpm-workspace.yaml` (add `site` to packages)

**Interfaces:**
- Produces: `pnpm -C site dev` serves the site; `pnpm -C site build` outputs `site/dist`. Brand components in `site/src/brand/` are standalone copies of the Task 1-2 components (the site package cannot import desktop source; BRAND.md governs both).

- [ ] **Step 1: Scaffold config files**

`site/package.json`:
```json
{
  "name": "colony-site",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "check": "biome check src"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```
Match major versions to `desktop/package.json` where the same dep exists (check before writing; keep React 19, Vite/Tailwind majors aligned with the repo).

`site/vite.config.ts`:
```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
});
```

`site/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Colony: your company, run by agents</title>
    <meta
      name="description"
      content="Colony is a company workspace where AI agents and people work together: chat, agent teams, workflows, canvas, and git."
    />
    <meta property="og:title" content="Colony" />
    <meta
      property="og:description"
      content="A company workspace where AI agents and people work together."
    />
    <meta property="og:image" content="/og.png" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`site/tailwind.config.js`, `site/postcss.config.js`, `site/tsconfig.json`, `site/biome.json`: minimal standard configs (content glob `./index.html`, `./src/**/*.{ts,tsx}`; extend colors `colony.violet: "hsl(258 90% 66%)"`, `colony.blue: "hsl(217 91% 60%)"`, `colony.pink: "hsl(330 81% 60%)"`, `colony.amber: "hsl(38 92% 50%)"`, `colony.green: "hsl(160 60% 45%)"`). Copy `biome.json` settings from `web/biome.json` as the baseline.

`pnpm-workspace.yaml` packages list gains `- "site"`.

- [ ] **Step 2: Copy brand components**

`site/src/brand/AntMark.tsx`, `WalkingAnt.tsx`, `palette.ts`: copies of the Task 1-2 files with the `@/shared/lib/cn` import replaced by inline `className` joins (already the pattern in those files) and the animations CSS import pointing at `./site-animations.css`, which contains the "Colony ant gait" block from Task 2 verbatim.

- [ ] **Step 3: Minimal App shell renders**

`site/src/main.tsx` standard React root; `site/src/App.tsx` renders `<main className="min-h-screen bg-zinc-950 text-zinc-50">Colony</main>` for now (Task 10 fills it).

- [ ] **Step 4: Install + build**

Run: `cd <worktree> && . ./bin/activate-hermit && pnpm install && pnpm -C site build && pnpm -C site check`
Expected: PASS, `site/dist/index.html` exists.

- [ ] **Step 5: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add site pnpm-workspace.yaml pnpm-lock.yaml && \
git commit -s -m "feat(site): scaffold Colony marketing site package"
```

---

### Task 10: Marketing site content + animations

**Files:**
- Modify: `site/src/App.tsx`
- Create: `site/src/sections/Hero.tsx`, `site/src/sections/Story.tsx`, `site/src/sections/Features.tsx`, `site/src/sections/Download.tsx`, `site/src/sections/Footer.tsx`, `site/src/brand/PheromoneTrail.tsx`, `site/src/brand/ScatterField.tsx`
- Create: `site/public/favicon.svg` (copy of icon artwork), `site/public/og.png` (rendered via `scripts/render-brand-png.mjs`, 1200x630)

**Interfaces:**
- Consumes: brand components from Task 9.
- Produces: complete single-page landing.

- [ ] **Step 1: ScatterField.tsx**

Site version of LandingAnts: same fixed-scatter + wander/repel pattern (copy from `desktop/src/features/onboarding/ui/LandingAnts.tsx`, adjust imports), lower density (14 ants), opacity 0.5, used as hero backdrop.

- [ ] **Step 2: PheromoneTrail.tsx**

```tsx
// Animated dashed path connecting points: "agents coordinating" visual.
// Dash offset animates via CSS; reduced motion shows the static dashed path.
export function PheromoneTrail({
  d,
  color,
  className,
}: {
  d: string;
  color: string;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={["pheromone-trail", className].filter(Boolean).join(" ")}
      viewBox="0 0 800 300"
      fill="none"
    >
      <path
        d={d}
        stroke={color}
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray="2 14"
        className="pheromone-trail__path"
      />
    </svg>
  );
}
```
With CSS in `site-animations.css`:
```css
.pheromone-trail__path {
  animation: pheromone-flow 2.4s linear infinite;
}
@keyframes pheromone-flow {
  to {
    stroke-dashoffset: -64;
  }
}
@media (prefers-reduced-motion: reduce) {
  .pheromone-trail__path {
    animation: none;
  }
}
```

- [ ] **Step 3: Sections**

- `Hero.tsx`: full-viewport, dark, `ScatterField` backdrop, centered `AntMark` (violet), h1 "Your company, run by agents", subhead "Colony is a workspace where AI agents and people build a company together: chat, agent teams, workflows, canvas, and git.", CTA button "Download for macOS" (href `#download`), secondary link "How it works" (href `#story`).
- `Story.tsx` (id="story"): three columns (Chat, Agents, Workflows) connected by two `PheromoneTrail` paths (violet, blue) behind them; one paragraph each.
- `Features.tsx`: grid of five cards (Channels, Agent teams, Workflows, Canvas, Git built in), each with a small `AntMark` tinted a different Colony hue.
- `Download.tsx` (id="download"): "Download Colony for macOS" button. Until the owned DMG URL is live, point at the GitHub releases page URL used by the desktop UpdateChecker (read it from `desktop/src/features/settings/UpdateChecker.tsx` during implementation) with copy "Apple Silicon macOS".
- `Footer.tsx`: "Colony", link to GitHub repo, lineage line "Built on Buzz", copyright line "AI Native Ventures".
- All copy: no em-dashes.

- [ ] **Step 4: favicon + OG image**

`site/public/favicon.svg`: the colony-source.svg artwork from Task 7 (copy file). OG image: create `site/og-source.svg` (1200x630, dark bg, violet ant + "Colony" headline), render: `node scripts/render-brand-png.mjs site/og-source.svg site/public/og.png 1200 630`.

- [ ] **Step 5: Build + eyeball**

Run: `cd <worktree> && pnpm -C site build && pnpm -C site preview` and open the printed localhost URL. Verify: hero renders, ants wander and repel from pointer, trails flow, responsive at 375px width (DevTools), reduced-motion freezes everything (DevTools rendering emulation).

- [ ] **Step 6: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add site && \
git commit -s -m "feat(site): Colony landing content, scatter field, pheromone trails"
```

---

### Task 11: Deploy site to Cloudflare Pages (preview gate)

**Files:**
- Create: `site/README.md` (deploy runbook)

**Interfaces:**
- Consumes: `site/dist` from Task 10.
- Produces: Cloudflare Pages project `colony-site`, preview URL for owner review. DNS cutover is a separate, owner-approved step.

- [ ] **Step 1: Check wrangler auth**

Run: `npx wrangler whoami`
If not authenticated: STOP and ask the owner to run `! npx wrangler login` (interactive). Do not proceed unauthenticated.

- [ ] **Step 2: Create project + deploy**

```bash
cd <worktree> && pnpm -C site build && \
npx wrangler pages project create colony-site --production-branch colony-rebrand 2>/dev/null; \
npx wrangler pages deploy site/dist --project-name colony-site
```
Expected: output includes a `*.pages.dev` URL. Open it, verify sections render.

- [ ] **Step 3: Write site/README.md runbook**

Document: build command, deploy command, project name `colony-site`, custom domain steps (Cloudflare dashboard: Pages > colony-site > Custom domains > add `colony.ainative.ventures`; requires the `ainative.ventures` zone in the same Cloudflare account), and the rule that DNS cutover happens only after owner approval.

- [ ] **Step 4: STOP: owner gate**

Post the preview URL to the owner. Do NOT attach the custom domain until the owner approves the preview. (Spec: "DNS cutover to colony.ainative.ventures only after preview approval.")

- [ ] **Step 5: Commit**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add site/README.md && \
git commit -s -m "docs(site): Cloudflare Pages deploy runbook"
```

---

### Task 12: Full verification pass + evidence

**Files:**
- Create: `desktop/tests/e2e/colony-brand.spec.ts`
- Test: full gates

**Interfaces:**
- Consumes: everything above.
- Produces: green `just ci`, green e2e smoke, screenshot set + gait GIF for owner review.

- [ ] **Step 1: Write colony-brand.spec.ts**

```ts
import { expect, test } from "@playwright/test";
import { installMockBridge } from "./helpers/e2eBridge";

// Brand smoke: the Colony mark renders and the bee is gone.
test("boot surfaces render the Colony ant", async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
  // At least one Colony mark on screen once the app renders.
  await expect(page.locator(".colony-mark").first()).toBeVisible();
  // No bee classes anywhere in the DOM.
  expect(await page.locator(".bee-sprite, .buzz-mark").count()).toBe(0);
});
```
Check `desktop/tests/e2e/` for the actual `installMockBridge` import path and register the spec in `playwright.config.ts` `smoke` project `testMatch` (per AGENTS.md). Adjust selectors to the app's mock-mode landing state if `/` needs auth: mirror the setup of `smoke.spec.ts`.

- [ ] **Step 2: Run the spec red-then-green sanity**

The spec must pass now (components exist). To confirm it actually guards, temporarily rename `.colony-mark` to `.colony-markX` in AntMark.tsx, run `cd <worktree>/desktop && pnpm test:e2e:smoke`, see FAIL, revert, see PASS.

- [ ] **Step 3: Full CI gate**

Run: `cd <worktree> && . ./bin/activate-hermit && just ci`
Expected: PASS (fmt, clippy, desktop lint/tests/build, px-text guard, web build, mobile tests).

- [ ] **Step 4: Screenshot evidence set**

```bash
cd <worktree> && \
just desktop-screenshot --name 01-colony-landing && \
just desktop-screenshot --name 02-colony-loading-gate && \
just desktop-screenshot --name 03-colony-settings --click open-settings && \
just desktop-screenshot --name 04-colony-home
shasum -a 256 test-results/screenshots/*.png
```
Expected: four PNGs, all hashes unique. Every visible surface shows ant branding, zero bee remnants, zero "Buzz" copy.

- [ ] **Step 5: Gait GIF**

Run the real app (`just desktop-standalone`), record the boot gate walking ant with macOS screen record (or `just desktop-screenshot` is static, so: QuickTime or `screencapture -v /tmp/colony-gait.mov` for ~5s), convert: `ffmpeg -i /tmp/colony-gait.mov -vf "fps=15,scale=480:-1" /tmp/colony-gait.gif`. Verify legs animate smoothly. Keep for the PR.

- [ ] **Step 6: Reduced motion check**

macOS System Settings > Accessibility > Display > Reduce motion ON, relaunch app: boot gate shows the static ant. Toggle back OFF.

- [ ] **Step 7: Commit + report**

```bash
cd <worktree> && . ./bin/activate-hermit && \
git add desktop/tests/e2e desktop/playwright.config.ts && \
git commit -s -m "test(desktop): Colony brand e2e smoke spec"
```
Report to owner: gates passed, screenshot set, GIF, site preview URL. PR + screenshot posting (scripts/post-screenshots.sh) happens after owner review.

---

## Plan Self-Review Notes

- Spec coverage: brand identity (T1-T3), in-app surfaces (T4-T5), strings (T6), icons/productName/DMG (T7), docs (T8), site (T9-T11), verification gates 1-6 (T11 step 4 covers the preview gate; T12 covers CI, e2e, screenshots, GIF, reduced motion). DNS cutover intentionally has no task: it is an owner-approved manual step documented in site/README.md.
- Naming deviation from spec: `FuzzyLogo` port is `FuzzyMark`, not `ColonyWordmark` (the original is a mark, not a wordmark). `ColonyLogoAnimation` is internal-only.
- Type consistency: `AntMark`/`WalkingAnt`/`FuzzyMark` names and prop shapes are identical across Tasks 1-5 and 9-10; `COLONY_HUES` used in T5 and T9-T10 matches T1's export.
