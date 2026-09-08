# Colony clear brand page implementation plan

**Goal:** Replace the rejected landing-page layout and abstract agency pitch with a literal explanation of what Colony makes and how a person uses it.

**Architecture:** Rebuild the marketing composition and stylesheet. Use the existing exact AntMark geometry, multi-hue gradient backgrounds informed by Instagram and the app canvas, and a clearly labelled interactive client-job illustration. Retain the tested email application helper and destination.

**Tech stack:** Existing React, TypeScript and CSS; no new dependencies or services.

## Design and acceptance

The user explicitly requested a replacement design, not a colour adjustment. Their latest direction supersedes the old single-hue canvas convention. The opening must identify Colony as an app, name websites and social media posts as outputs, explain giving instructions and client information, and show review and changes. New and existing agencies remain the audience; client discovery follows the explanation of what they can sell.

Use flowing violet, blue, pink, amber and green backgrounds, exact solid-colour ant marks, rounded readable app-like panels, and visible ants outside text. Show one fictional bakery's instructions before its website and post, both outputs together. An example-change button demonstrates the review loop and is labelled as an illustration, never a real product run. Preserve reduced-motion support and keep decorations out of the accessibility tree.

## Tasks

- [x] Replace App and Hero composition, old styles and random single-hue head script. Introduce decorative BrandField using AntMark and a static layered gradient. Introduce a responsive ExampleJob with input, output and example revision states.
- [x] Replace the general product tour with concrete owner steps, recurring website/social work, client discovery and plain answers. Update metadata to explain the actual work.
- [x] Restyle the early-access area as a readable white form on a dark multi-hue canvas. Preserve recipient basheer@ainative.ventures, validation, copy fallback and honest email-draft handoff.
- [x] Run site check, typecheck and build. Inspect wide, tablet, 390px and 320px layouts, loaded assets, example revision, keyboard access, FAQ and application flow. Check contrast and reduced motion. Independently review copy for unexplained assumptions and visual result against the app/Instagram references.
- [ ] Complete repository gates, signed commits and release PR. Require every non-skipped check before main merge. Verify deployed bytes and live browser behavior; confirm automatic backmerge and clean up temporary servers.

## References inspected

- Public Instagram @colony.agents: violet/pink/light gradient launch artwork; saturated blue, green and pink gradient panels; solid ant mark and app conversations.
- docs/BRAND.md and exact AntMark/palette source.
- App onboarding canvas source: radial gradients, grain, translucent panels, wrapper-level ant movement and reduced-motion handling. Native app AX was readable, but screenshot capture timed out; no claim of full native visual QA.

No new promise of automatic publishing, sales, client approval portals or proven end-to-end AI delivery is introduced. Early-access availability remains explicit.

## Local proof

- Full repository `just ci`: passed with exit code 0, including formatting, lint, desktop/core tests, builds and 967 mobile tests (one skipped).

- `pnpm -C site check`: passed, including all three existing application-email tests.
- `pnpm -C site typecheck` and production build: passed. Entry bundle `/assets/index-CJf5SUer.js`; stylesheet `/assets/index-CNctQ48u.css`.
- Browser inspection at 1440, 1280, 768, 390 and 320 pixels: no horizontal overflow; readable hero, instructions, both deliverables, service cards, discovery and application.
- Example revision changes Saturday hours from 4 pm to 2 pm and shortens the post; keyboard reset restores both and clears highlights.
- FAQ opens with Enter. Application rejects empty required fields, focuses the first invalid field, prepares an encoded email to the confirmed recipient, focuses the draft, and removes the stale draft when an answer changes. No email was sent.
- Browser error/warning log empty. Both example images loaded. Production metadata points to the new 1200 by 630 sharing card, visually checked for correct ant geometry.
- Ant animation iteration count is one; source explicitly disables animation under reduced motion. An OS reduced-motion setting was not simulated.
- Independent copy and source reviews completed. Corrected shorthand wording, example voice, changed-detail readability, infinite motion and the sharing-image reference.

No claim is made that the illustration proves Colony completing a real client job, or that an unfamiliar person has passed a comprehension test.
