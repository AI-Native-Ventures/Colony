# Colony living-brand polish

The owner approved the current story and page, and asked for a green/blue early-access background, a stronger footer, moving ants like the original site and gradient variation on reload. This is a focused visual/motion pass; no further product-positioning change is intended.

## Design and implementation

- Keep the legible central hero, exact Colony ant geometry and approved typography. Choose one of four curated multicolour gradient arrangements once per load; avoid repeating the previous arrangement when session storage is available. Keep all palette variants pale enough for the existing dark copy. Do not change colour during form or tour interaction.
- Bring back the existing WalkingAnt sprite with slow, varied CSS transform paths. Use a gentle, bounded pointer reaction around the ants on fine-pointer devices. No WebGL dependency is necessary for this effect: use the browser compositor and existing SVG artwork.
- Add a small Pause motion control. Respect live reduced-motion changes, pause animation offscreen and in hidden tabs, and clean up listeners/observers/pending frames. Keep ants away from reading areas and controls, with smaller motion on phones.
- Restyle the application band with rich green, teal and blue gradients and retain the white, accessible form.
- Replace the thin footer with a substantial brand close: clear product definition, working in-page navigation, the confirmed contact address and an oversized Colony wordmark. No invented destinations or unsupported product claims.

Files: App.tsx / Hero.tsx wire state and composition; brand/BrandField.tsx and brand/living-brand.css own motion; brand/brandScene.ts owns per-load palette choice; sections/Footer.tsx and footer.css own the closing section; early-access.css owns the green-blue band. Preserve email logic and business walkthrough.

## Acceptance

Check repeat reloads produce a different curated blend; form/tour actions do not change it. Verify ant movement, pointer response, manual pause/resume, offscreen/hidden-tab pause and reduced-motion behavior. Inspect initial and moving ant bounds against hero text at phone/tablet/desktop sizes. Verify footer links and green-blue section contrast; confirm no horizontal overflow or console errors. Run site checks/typecheck/build and required repository CI, then PR/deploy/exact-asset and live-browser gates. Keep primary checkout untouched.

## Local verification

- Site check (42 files and three email tests), TypeScript and production build passed. Final local assets: `index-DuRGMZua.js` and `index-DjpqQUW_.css`.
- Browser checks covered all four palettes, nonrepeating consecutive reloads, stable palette during form interaction, pointer response, pause/resume, offscreen pause and ant clearance at 320, 390, 1080, 1280/1281 and 1440 pixels. Footer and application layout remained within the viewport; required fields and the unsent email draft behaved correctly. No console warnings or errors were observed. Hidden-tab and reduced-motion handling were reviewed in source rather than browser-emulated.
- The first full `just ci` run passed every gate except one unchanged mobile receipt test (`an applied receipt resolves to the task the relay named`). The nine-test file passed on a clean export of `origin/main`. Its expected action and submitted action are signed separately with current-second timestamps; a timestamp boundary is a plausible fixture mismatch, not a captured proof of the original failure's cause. No mobile source or tests were changed.
- A complete `just ci` rerun passed with exit 0, including 6,801 desktop JavaScript tests and 967 mobile tests (one mobile skip). Logs: `/private/tmp/colony-living-brand-ci-first.log`, `/private/tmp/colony-living-mobile-targeted.log` and `/private/tmp/colony-living-brand-ci.log`.
- PR checks, deployment, exact served bytes and public-browser acceptance remain separate release gates.
