# design-sync notes, Colony

Repo-specific gotchas for anyone re-running `/design-sync` here. Read this
before touching `.design-sync/config.json`.

## Shape of this sync

Colony has no design-system package. What syncs is the desktop app's component
library, `desktop/src/shared/ui`, scoped to 25 core primitives via
`cfg.componentSrcMap`. Two sync-only files live in `desktop/`. Both are hand
written and committed, and neither is part of the app build (nothing imports
them; only the converter's `--entry` reaches them):

- **`desktop/ds-entry.tsx`**, the barrel the converter bundles. `export *` per
  component file, plus `ThemeProvider` and `ColonyProvider`. To widen the sync,
  add the file here AND add the component name to `cfg.componentSrcMap`.
- **`desktop/ds-provider.tsx`**, `ColonyProvider`, wired as `cfg.provider`.
  See "The provider is load-bearing" below before changing it.

There is no `dist/`, so the converter runs in synth-entry mode against
`--entry desktop/ds-entry.tsx`. `PKG_DIR` is resolved by walking up from that
entry to `desktop/package.json`, which is why the entry must live in `desktop/`
and not at the repo root.

## Rebuilding the stylesheet (do this first, every re-sync)

`cfg.cssEntry` is `desktop/ds-styles.css`, which is a **copy of the app's
compiled Tailwind output**, not a source file. Tailwind v4 generates utilities
from a content scan, so the source `globals.css` is useless to the converter -
it is all `@import` and `@config`. Regenerate it:

```sh
cd desktop && npx vite build --outDir dist-ds
cp desktop/dist-ds/assets/index-*.css desktop/ds-styles.css
perl -pi -e 's{url\(/assets/}{url(./dist-ds/assets/}g' desktop/ds-styles.css
```

The `perl` line is required: the compiled CSS references fonts at absolute
`/assets/…` paths, which resolve nowhere relative to `desktop/`, and the
converter silently ships zero `@font-face` files if you skip it. The vite
output filename is content-hashed, so the `cp` glob has to be re-run, a stale
`ds-styles.css` is invisible in the build log.

## The provider is load-bearing (two separate traps)

`cfg.provider` is `ColonyProvider`. It does two things, and each fixes a
failure that looks like something else:

1. **It installs a stub `NativeBridge` at bundle load.** Several modules call
   `isTauri()` during render; `getNativeBridge()` throws when nothing is
   installed. The throw happens inside React's concurrent render, so it escapes
   the preview card's `try/catch` and produces a **silently empty root**.
   Symptom: every card blank, `package-capture` still reporting
   `0 with errors` and enumerating cells normally.
2. **It supplies a fixed theme context value instead of running the real
   `ThemeProvider`.** `DialogOverlay` and `SheetOverlay` call `useTheme()` for
   their backdrop tint, so *something* must provide the context, but the real
   `ThemeProvider` rewrites the theme custom properties on `:root` at runtime
   and replaces Colony's purple palette with a generic near-black one. Cards
   under it render, and are wrong.

This required one change in app source: `ThemeContext` is now exported from
`desktop/src/shared/theme/ThemeProvider.tsx` (a `const` gaining `export`, plus
a doc comment, no behaviour change). If that export is ever removed,
`ds-provider.tsx` stops compiling.

**Purple primary is the standing smoke test.** Colony's `--primary` is
`266 85.05% 58.04%`. If a capture comes back with a near-black primary, the
provider is half-wired, that is a broken intermediate state, not a theme
variation.

## Known render warns (all triaged, all expected)

- `[TOKENS_MISSING]`, ~16 custom properties (`--sidebar-width`,
  `--skeleton-width`, `--home-inbox-list-width`, `--ui-warning`, …). These are
  set at runtime by app layout code, not by any stylesheet. Not a packaging
  miss.
- `[FONT_MISSING]`, names `Inter`, `Avenir Next`, `Cambria`,
  `JetBrains Mono`. These are fallback entries inside font stacks whose first
  choice (`Inter Variable`) does ship. JetBrains Mono itself IS shipped via
  `cfg.extraFonts` pointing at `@fontsource/jetbrains-mono`.

## Traps in the harness itself

- **A blank card is not a capture error.** `0 with errors` is not evidence that
  anything rendered. The tells are `pageErrs` in
  `.design-sync/.cache/review/<Name>.json` and byte-identical PNG sizes across
  unrelated components. Read the sheets every iteration.
- **`package-capture.mjs` skips components that already have a grade**, printing
  `carried forward` and capturing nothing. After a bundle rebuild, anyone told
  to "re-run your loop" needs `--force`, or they will re-read stale PNGs and
  grade images that no longer correspond to the build.
- **`package-capture.mjs` is not concurrency-safe.** It clears
  `_screenshots/review/` (including `raw/`) at the start of every run, so
  parallel authoring agents delete each other's sheets mid-read and occasionally
  hit ENOENT. A plain retry works. Read PNGs immediately after your own capture.
- **Any `cfg.overrides` / `cfg.titleMap` edit blocks every incremental
  rebuild** with `[CONFIG_STALE]` until one full `package-build.mjs` re-stamps
  the grade keys. Authoring agents may not run that. Sequence config edits
  BEFORE spawning batches.
- **The generated `.d.ts` files are empty contracts.** Every component emits
  `export interface XProps { [key: string]: unknown }`. The design agent
  therefore learns nothing about variants from them, which is why
  `conventions.md` enumerates the variant vocabulary by hand. The `cva` blocks
  in `desktop/src/shared/ui/*.tsx` are the only real source.

## Component-specific findings

- **`ContextMenu` has no `defaultOpen`.** Radix's `ContextMenu.Root` keeps
  `open` in a plain `useState(false)` and exposes only `onOpenChange`, `dir`,
  `modal`. The usual "open it with `defaultOpen`" is a silent no-op here (it
  works for `DropdownMenu`). Its preview dispatches a real `contextmenu`
  `MouseEvent` at `clientY: rect.bottom + 6`, below the trigger, so the menu
  does not cover the row it belongs to. `react` is importable in previews
  (`bundle.mjs` shims it to `window.React`), so hooks are available.
- **`Carousel` arrows need a padded wrapper.** `CarouselPrevious`/`Next` are
  positioned at `-left-12`/`-right-12` of the carousel ROOT, so padding on the
  `Carousel` itself does nothing and the arrows get sliced at the cell edge.
  Wrap in `<div className="w-full px-14">`. Also give it more items than fit -
  with 3 items at `basis-1/3` nothing overflows and both arrows render
  disabled, which reads as a broken control.
- **`Skeleton` pulses on an infinite loop** and the capture lands anywhere in
  it, so a cell can screenshot mid-fade and read washed out. `pulsing={false}`
  gives a stable capture; one cell keeps the default pulse so the axis is still
  visible.
- **`Progress value={0}`** renders a correctly empty track and only reads as
  intentional inside a labelled ladder (0 / 25 / 72 / 100).
  `value={null}` is the indeterminate sweep and its captured position varies
  run to run.
- **Radix controlled inputs** need `defaultChecked` / `defaultPressed` or every
  cell looks identical. `checked` + `disabled` (not `defaultChecked` +
  `disabled`) is what produces a *disabled checked* cell.

## Not covered

- **`Card variant="textured"` does not paint in the bundle.** The asset and
  rules DO ship, all four `.buzz-card-textured*` selectors survive into
  `_ds_bundle.css`, each with a real base64 PNG in
  `--buzz-card-textured-source`. It still renders as bare text on a plain
  background. Probed twice, before and after the provider fix, unchanged.
  Leading hypothesis (unconfirmed): cascade order in the flattened bundle
  stylesheet, `TEXTURED_SURFACE_CLASS` includes the Tailwind `border-0`
  utility, and `border-image` needs a non-zero border, so if the utility layer
  is emitted after `card-texture.css` the texture is zeroed. Card ships four
  other cells; `textured` is the only unrepresented value on its variant axis.
  Two things would need deciding before re-adding the cell: the layer-order
  fix, and a tinted card viewport (the texture is white-centred and the review
  background is near-white, so it would be close to invisible either way).
  `card-texture.css` also documents a 96px outer bleed that an
  `overflow: hidden` ancestor will clip.
- Hover, drag and focus-ring states, not statically renderable.
- Only 25 of ~90 files in `desktop/src/shared/ui` are synced. The rest
  (`UserAvatar`, `PubKey`, `markdown`, `VideoPlayer`, link previews, `sidebar`)
  are Colony-specific and mostly depend on relay data or Tauri IPC.

## Re-sync risks

Things that can go stale silently, in rough order of how quietly they fail:

1. **`desktop/ds-styles.css` is a build artifact checked in by hand.** Any
   Tailwind class added to a component after the last copy is simply absent
   from the bundle, and the component renders unstyled in exactly that one
   respect. Always regenerate it (above) before a re-sync, do not trust the
   existing file.
2. **`desktop/ds-entry.tsx` is a hand-maintained barrel.** A component added to
   `shared/ui` does not appear in the sync until someone adds both the
   `export *` line and the `componentSrcMap` entry. Nothing warns.
3. **`ThemeContext`'s export in app source** is the one load-bearing change
   outside the sync-only files. A refactor that unexports it breaks
   `ds-provider.tsx` and, through it, every card.
4. **`ColonyProvider`'s static theme value** is a hand-written copy of
   `ThemeContextValue`. If that type gains a field, the object goes stale;
   TypeScript will catch a missing field only if someone typechecks
   `ds-provider.tsx`, which the app build does not do.
5. **The preview compositions encode current API shape** (variant names, sub-
   component names). A renamed variant leaves the preview compiling against a
   value that no longer exists in `cva`, and it silently falls back to the
   default variant rather than failing.
6. The bundle was verified in headless Chromium only, at the card viewports.
   Nothing here proves how these look in the claude.ai/design pane itself.

## The bundled stylesheet only contains utilities the app already uses

`_ds_bundle.css` is compiled Tailwind output, not a live runtime, so a valid
Tailwind class that `desktop/src` never uses simply does not exist and silently
no-ops. Confirmed absent at time of writing: `min-h-screen`, `space-y-4`,
`gap-11`, `p-7`, `h-52`, `gap-0.5`, and the configured-but-uncompiled
`ring-ring`, `text-nsec-key`, `text-status-modified`. Confirmed present: the
ordinary values (`h-80`, `pt-2`, `p-4`, `px-6`, `mt-4`, `gap-2`, `max-w-md`,
`items-center`, `justify-center`, `rounded-2xl`, `text-2xs`, `bg-accent`).

This bites hardest on portalled overlays: batch C's Tooltip appeared to have a
wrong `side` prop, when in fact `h-52` did not exist, the container collapsed,
and Radix flipped the tip for lack of room. Grep the CSS before relying on a
class, or use an inline `style`. The same rule is stated for the design agent
in `conventions.md`.

## Grading practice

- **Do not grade dense cards off the composited review sheet alone.** It
  downscales, which made a crisp Sheet card look washed out and nearly failed
  it. Check `_screenshots/review/raw/<group>__<Name>__<Cell>.png` for anything
  detailed.
- **Purple landmarks are the fast palette check:** PageHeader's "Invite member"
  button, Spinner's "Creating channel" button, ContextMenu's unread badge, and
  Avatar's agent-identity fallback tint should all be purple. Near-black means
  a half-wired provider.
- **Serialise `package-build.mjs` against running captures.** A build wipes
  `_screenshots/review/raw/` and kills any capture mid-run with ENOENT. It also
  moves the stamped `sourceKey`, so the next capture **deletes** any grade
  minted before it, and it wipes `.design-sync/learnings/`. During a fan-out
  that makes an orchestrator rebuild look like a batch that never did its work:
  read "batch X has no grades" as "my rebuild may have deleted them" before
  concluding anything. Sequence config edits and rebuilds before spawning
  batches, not during.

## Component fixes worth keeping

- **`Sheet`'s close button shows a permanent focus ring** because Radix
  autofocuses it on open and `SheetContent`'s close styles with `focus:ring-2`
  rather than `focus-visible:`. The preview passes
  `onOpenAutoFocus={(e) => e.preventDefault()}`, which the product itself
  already uses. This is arguably a real component bug worth fixing upstream.
- **Native form controls look wrong next to these components.** A raw
  `<input type="radio">` renders as a browser-default blue control against the
  Colony palette; the Popover preview uses token-styled rows instead.
