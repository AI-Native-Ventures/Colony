# Colony Brand

Single source of truth for Colony branding. Mobile and web clients copy from
here when they rebrand. Every value below was checked against the committed
source it documents; if code and doc ever disagree, the code wins and this
file needs a fix.

## Name

Colony. The desktop app is "Colony". Marketing domain:
https://colony.ainative.ventures

Colony is built on Buzz, the open-source relay and app platform from Block.
Internals (crates, env vars, the Nostr protocol surface) stay named Buzz
until a later technical rename phase; this document covers user-visible
brand only.

## Palette

Dark surfaces are unchanged from the app theme. Brand hues, verified against
`desktop/src/shared/ui/colony-logo/palette.ts` (`COLONY_HUES`):

| Token | Value | Use |
|---|---|---|
| violet (primary) | hsl(258 90% 66%) | Primary accent, icon background |
| blue | hsl(217 91% 60%) | Scatter/accent |
| pink | hsl(330 81% 60%) | Scatter/accent |
| amber | hsl(38 92% 50%) | Scatter/accent |
| green | hsl(160 60% 45%) | Scatter/accent |

## Mark

Geometric minimal ant, side profile, `viewBox="0 0 466 309"`, rendered in
`currentColor`. Geometry below is verified against
`desktop/src/shared/ui/colony-logo/AntMark.tsx`, the source of truth shared
by every mark component:

- Body: abdomen `cx=104 cy=172 r=80`, thorax `cx=226 cy=164 r=52`, head
  `cx=313 cy=148 r=46`.
- Eye cutout (masked out of the head): `cx=335 cy=136 r=11`.
- Legs, `stroke-width=14`, round caps, six paths (two tripods):
  `M202 203 L136 292`, `M220 210 L196 298`, `M235 209 L246 300`,
  `M247 205 L294 294`, `M257 198 L336 282`, `M164 215 L112 272`.
- Antennae, same stroke: `M327 114 Q345 64 397 50`,
  `M343 126 Q377 86 427 80`.

An earlier draft of this mark placed the head at `cx=330`; that was wrong
and was corrected during initial review because the legs floated off the
body and the head did not touch the thorax. `cx=313` is the only correct
value. Do not copy geometry from anywhere except `AntMark.tsx` itself.

Components, all under `desktop/src/shared/ui/colony-logo/`:

- `AntMark` - static mark, plain SVG, no animation.
- `WalkingAnt` - animated walking gait, used by loading states.
- `FuzzyMark` - textured/pulsing mark, used by agent liveness indicators.
- `ColonyLogoAnimation` - internal engine `FuzzyMark` renders through; not
  used directly by feature code.
- `palette.ts` - the brand hues above, as exported constants.

There is no component named "ColonyWordmark". An earlier design doc used
that name; it was never implemented, and `FuzzyMark` is the real name for
the textured/pulsing mark.

### Stroke weight by context

The in-app UI mark (`AntMark`, `WalkingAnt`, `FuzzyMark`) uses
`stroke-width="14"` at native `466x309` proportions. The packaged app icon
(`desktop/src-tauri/icons/colony-source.svg`, a white ant on a violet
rounded square) uses a thickened `stroke-width="26"` with a `scale(1.9)`
transform on the mark group. These are not interchangeable: the icon's
heavier weight was arrived at empirically, not chosen up front.
`stroke-width="22"` with `scale(1.7)` was tried first and failed
legibility at 32px, the smallest bundled raster size (individual leg
strokes visually fused into one solid fan). Re-rendering at 26/1.9 restored
six visibly separate legs at 32px. If you build an icon variant for another
platform, re-derive the weight for that platform's smallest bundled size
rather than reusing 14 or assuming 26 transfers unchanged; verify at the
actual smallest shipped pixel size before calling it done.

## Motion primitives

1. **Walking gait** (`WalkingAnt`): alternating leg-tripod gait, 0.42s
   cycle. Transforms live on HTML-level wrapper elements only, never on SVG
   children directly (see Technical constraints below).
2. **Pheromone trails**: animated dashed SVG paths connecting points, used
   on the marketing site to show agents coordinating. Built in a later
   phase of this rebrand, not yet implemented as of this document.
3. **Scatter field** (`LandingAnts`): a fixed 38-row scatter of
   multi-hue ants with pointer repel, used on the landing/onboarding
   surface.

Every animation has a `prefers-reduced-motion: reduce` fallback to a static
state. No em-dashes in user-facing copy, anywhere.

## Technical constraints

These were discovered painfully during implementation. Re-derive them
instead of re-learning them if you rebuild these components for mobile or
web:

1. **Animate wrapper elements, never SVG children.** WebKit paints SVG
   *children* (e.g. a `<path>`) on the main thread, so a transform
   animation placed directly on one freezes for as long as boot work
   (bundle eval, first render) hogs the thread, which is exactly the window
   a loading gate is on screen. Put the animated transform on an
   HTML-level wrapper (a `<div>` around the `<svg>`), where it runs on the
   compositor instead.
2. **Wrap component stylesheets in `@layer components`.** Unlayered CSS
   beats Tailwind's `@layer utilities` regardless of selector specificity.
   Left unlayered, a stylesheet for these marks silently defeats consumer
   overrides such as `[&>svg]:h-full` at the call site.
3. **Reduced motion must be handled per mechanism, not just in CSS.** SVG
   SMIL `<animate>` elements are not stopped by CSS `animation: none`; a
   SMIL-driven effect must be omitted from the DOM outright under
   `prefers-reduced-motion: reduce`, not merely disabled with CSS.
4. **Do not use cairosvg to check these marks.** It mis-renders the
   mask-based eye cutout used by every mark component. Verify visually with
   Playwright/Chromium instead.
5. Every animation needs an explicit `prefers-reduced-motion: reduce`
   fallback to a static state; this is not optional per-component polish.

## Do / Don't

- Do tint the mark with `currentColor` through theme tokens.
- Do keep the 466:309 aspect ratio wherever the mark renders.
- Do re-verify stroke weight at the smallest pixel size a new context
  actually ships, rather than reusing 14 or 26 by assumption.
- Don't stretch, outline, or add gradients to the mark.
- Don't reintroduce bee assets or bee-themed names in user-visible
  surfaces. Buzz naming survives only in internals (env vars, crates, the
  protocol) until the technical rename phase.
- Don't render or QA these marks with cairosvg; use Playwright/Chromium.
