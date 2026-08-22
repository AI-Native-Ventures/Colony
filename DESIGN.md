# Colony design system

Generated from committed code: `desktop/tailwind.config.js`,
`desktop/src/shared/styles/globals/theme.css`, `docs/BRAND.md`, and the 25
components synced to the Colony Design System project. Code wins on any
disagreement.

## Color

Themes are Catppuccin-derived. Latte for light, Macchiato for dark. Values are
HSL triplets consumed as `hsl(var(--token))`, so every color reaches CSS through
a semantic token, never as a literal.

Light theme (`:root`):

| Token | Value | Role |
|---|---|---|
| `--background` | `220 23.08% 94.9%` | Page. A tinted off-white, never `#fff`. |
| `--foreground` | `234 16.02% 35.49%` | Body text. A desaturated indigo, never `#000`. |
| `--primary` | `266 85.05% 58.04%` | Colony violet. Primary actions, agent presence. |
| `--muted` / `--secondary` | `223 15.91% 82.75%` | Recessed surfaces, secondary buttons. |
| `--muted-foreground` | `233 12.8% 41.37%` | Meta text, timestamps, helper copy. |
| `--destructive` | `347 86.67% 44.12%` | Destructive actions only. |
| `--border` / `--input` | `225 13.56% 76.86%` | Dividers and field outlines. |
| `--radius` | `0.625rem` | Base radius. `rounded-md` and `rounded-sm` derive from it. |

Brand accent hues, for scatter fields and multi-agent surfaces, never for UI
status: violet `hsl(258 90% 66%)`, blue `hsl(217 91% 60%)`, pink
`hsl(330 81% 60%)`, amber `hsl(38 92% 50%)`, green `hsl(160 60% 45%)`.

Color strategy for product surfaces is **restrained**: tinted neutrals with
violet under 10% of the surface. Onboarding is the documented exception, since it
is the one product surface doing identity work.

## Typography

- Sans: Inter Variable, falling back to Inter, Avenir Next, Segoe UI.
- Mono: JetBrains Mono. Used for keys, ids, relay URLs, and code.
- Chat body and author text is `text-base` (16px). That is the app's base size,
  and the timeline scale steps off it.

Sizes are rem only. The app implements Cmd +/- zoom by scaling the root
font-size, so any px text is frozen against zoom. A CI guard
(`pnpm check:px-text`) fails the build on arbitrary text-size literals, px or
rem.

Below `text-xs` the scale is three named tokens: `text-2xs` (0.6875rem, the
meta-text workhorse for timestamps and count badges), `text-3xs` (0.5rem, tiny
glyphs), `text-badge` (0.625rem, compact status badges). Display sizes:
`text-title` (2.5rem, tightened tracking) and `text-nsec-key` (2.25rem mono).

## Elevation

Two custom shadows, both solving problems Tailwind's y-offset stock shadows do
not:

- `shadow-content-edge`: a 1px hairline for a surface meeting the sidebar.
- `shadow-panel-left`: hairline plus soft lift, both cast on -x, for a panel
  whose only exposed edge faces left.

Otherwise elevation is carried by background tint and border, not by drop
shadows. Glass effects exist behind an opt-in preference and are not a default.

## Components

25 primitives synced to Claude Design, all real app code:

Alert, AlertDialog, Avatar, Badge, Button, Card, Carousel, Checkbox,
ContextMenu, Dialog, DropdownMenu, Input, PageHeader, Popover, Progress,
Separator, Sheet, Skeleton, Spinner, StepProgress, Switch, Tabs, Textarea,
Toggle, Tooltip.

Variant vocabulary that is not visible in the generated types:

- `Button` variant: default, secondary, outline, ghost, link, destructive.
  Size: default, sm, xs, lg, icon, icon-xs.
- `Badge` variant: default, secondary, outline, destructive, warning, success,
  info. Uppercase and letter-spaced by design, so labels stay to one or two
  words.
- `Alert` variant: default, destructive.
- `Toggle` variant: default, outline.

Anything mounted outside the Tauri shell must be wrapped in `ColonyProvider`,
which installs the native-shell stub and supplies the theme context that Dialog
and Sheet read. Without it the tree renders blank rather than erroring.

## Motion

Three brand primitives, implemented in `site/src/brand/`:

| Primitive | Mechanism | Use |
|---|---|---|
| Walking gait | `ant-step-a` / `ant-step-b` leg tripods plus `ant-body-bob`, 0.42s cycle | Loading and working states |
| Pheromone trail | `pheromone-flow` on dashed SVG paths | Agents coordinating, connections forming |
| Scatter field | Multi-hue ant field with pointer repel | Landing and onboarding surfaces |
| Wing flap | `ant-wing-flap-fore` / `ant-wing-flap-hind` | Winged variant, sparingly |

Four constraints, each learned the hard way and documented in `docs/BRAND.md`:

1. **Animate wrapper elements, never SVG children.** WebKit paints SVG children
   on the main thread, so a transform on a `<path>` freezes for as long as boot
   work holds the thread, which is exactly when a loading gate is on screen. Put
   the transform on an HTML wrapper `<div>` so it runs on the compositor.
2. **Wrap component stylesheets in `@layer components`.** Unlayered CSS beats
   Tailwind's `@layer utilities` regardless of specificity, and silently defeats
   consumer overrides at the call site.
3. **Reduced motion is per mechanism.** SMIL `<animate>` elements ignore CSS
   `animation: none`. A SMIL effect must be omitted from the DOM outright under
   `prefers-reduced-motion: reduce`.
4. **Verify marks in Playwright or Chromium, never cairosvg**, which mis-renders
   the mask-based eye cutout.

Easing is exponential ease-out. No bounce, no elastic, and never animate layout
properties.
