# Colony onboarding prototype

Clickable prototype of the ten-screen onboarding flow specified in
`docs/superpowers/specs/2026-08-21-onboarding-redesign-design.md`.

Open `index.html` by double-clicking it. Nothing to install, no server needed.

## What is real

Every control is the actual Colony component from the synced design system
(`Button`, `Input`, `Textarea`, `Checkbox`, `Progress`), rendering against the
app's compiled stylesheet and shipped fonts. The ant geometry and the walking
gait are copied verbatim from `docs/BRAND.md` and `site/src/brand/`.

## What is fake

Payment, website reading, agent detection, and installation are all timers.
No network calls, no filesystem access, no money.

## Controls

Bottom right, "Prototype controls":

- **No agent found / Agent found** switches between the two branches. This is
  the branch the real flow picks by probing the machine at screen 4.
- **Website unreachable** routes screen 7 to its failure path.
- **Agent setup fails** routes screen 5b to its failure path.
- **Card declined** makes the payment on screen 9 fail.
- The dropdown jumps straight to any screen.

## Layout

- `index.html` loads the design system, then the prototype.
- `app.css` is the prototype's own styles, deliberately plain CSS. The design
  system stylesheet is compiled Tailwind output, so it only contains utilities
  `desktop/src` already uses. Inventing utility classes here would silently
  do nothing.
- `src/app.jsx` is the flow. Rebuild after editing:

  ```sh
  ../../.ds-sync/node_modules/.bin/esbuild src/app.jsx --bundle \
    --outfile=app.js --loader:.jsx=jsx --format=iife
  ```

- `ds/` is a copy of the built design system bundle. Gitignored, along with
  `app.js`. Refresh it from `ds-bundle/` after a design system re-sync.
