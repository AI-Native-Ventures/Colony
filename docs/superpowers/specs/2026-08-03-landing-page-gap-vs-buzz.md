# Landing page: the real gap vs buzz.xyz

**Status:** Closed 2026-08-03. Diagnosed from side-by-side captures; items 1
and 3 implemented the same day (commit `6424dc44f`), items 2 and 4 that
evening (`c147cf9d8`), and the wordmark's blur radius decided and applied
(`d7bd7816b`).

First, a correction to the assumption behind this document: buzz.xyz's
marketing site is **not** in the open-source repo, so there was never a
source to fork and reskin. `git ls-tree upstream/main` has no site/, www/,
landing/ or marketing directory, and the `web` directory it does have is the
relay's in-app repo browser. The structure below was replicated from the
captures, not ported.

Captures: `desktop/test-results/site-features/buzz-1200.png`,
`buzz-2400.png` (buzz.xyz at scroll offsets — its sections animate in, so a
full-page screenshot renders them blank), and `full-page.png` (ours).

## What buzz.xyz actually does

**1. The product shot is the page.** One screenshot, ~1040px wide in a 1280
viewport, inside a near-black rounded frame with generous inner padding, so
the app's white chrome sits on dark and pops. It occupies most of a viewport
on its own.

Its *content* is doing as much work as its size:

- Real human names and photographic avatars (Marcus Reed, Elena Torres,
  Maya Chen, Theo Martin), not initials in grey circles
- A syntax-highlighted code block
- A Linear issue embed with an icon
- Emoji reactions with counts
- A threaded @mention with a genuine technical argument ("Move it to
  Flutter now. One codebase, both platforms")

It reads like a real team mid-decision. Ours reads like a fixture.

**2. Three white cards, not alternating rows.** Below a large centered
statement ("Your people, your agents, your project — all in one place."),
three equal white cards on a pale tinted background. Each card is:

  [ 3D claymation character, ~90px, top-left ]
  [ generous whitespace ]
  [ small bold heading ]
  [ 3-line body ]

Headings: "Communicate with your team", "Bring in your agents", "Manage your
git projects".

**3. Custom 3D characters.** A yellow bee, a red ladybug, a blue bug —
rendered claymation-style with real lighting and shadow. This is the single
biggest visual asset gap. We have a flat 2D SVG ant mark and nothing else.

**4. Per-section background colour.** Chartreuse hero, pale blue card
section. Consistent per load (not random, which is what ours was doing), but
the page is not one flat surface either.

## What ours does instead

- Product screenshot renders at ~1140px but on a pale background with a thin
  border, no dark frame, so it recedes instead of dominating
- Feature imagery is small alternating side-by-side screenshots
- No character illustrations at all
- Fixture-grade screenshot content: "mira / Default model", initials in grey
  circles, a single workflow line

## Work required, in impact order

1. ~~**Reframe ProductShowcase**~~ — done. Near-black (#211f1f) rounded frame
   at max-w-6xl with p-16 inner padding. Doing this exposed a defect the pale
   background had been hiding: the capture carried ~8px of Buzz-era
   chartreuse, rgb(212,219,201), down its right and bottom edges. Cropped.
2. ~~**Richer seeded screenshot content**~~ — done, and the story changed with
   it. The shot is a `#growth` channel, not an engineering release thread:
   Colony's own claim (people and agents running a company) instead of
   Buzz's. Named humans with initials, both agents carrying starter-team
   renders, a markdown table of ranked target companies, reactions with
   counts, and a thread summary. It lives in
   `desktop/tests/e2e/site-feature-screenshots.spec.ts` as "capture: the
   company channel hero shot", so it regenerates instead of being tuned by
   hand. Three things that had to be learned by looking at the output:
   messages seeded **before** the channel opens arrive as history (live
   delivery paints a NEW rule and floats "4 new messages" over the header);
   the channel needs opening, leaving, and reopening for that history to
   count as read; and two extra opening messages are what push the
   empty-channel cards and the sticky day-divider pill above the fold.
3. ~~**Three cards instead of alternating rows**~~ — done, as
   `site/src/sections/Cards.tsx`, replacing both Story and Features. 1024px
   row, 20px gutters, ~24rem cards, headings on a fixed offset below the
   tile so they align across all three regardless of body length.
4. ~~**Character illustrations.**~~ — done, and it cost nothing, because the
   art already existed. This was written up as a design commission on the
   assumption that Colony had no rendered characters. It has three: Scout,
   Forager, and Tender, the starter team the desktop app introduces at
   onboarding (`desktop/public/onboarding/starter-team/*.png`), rendered
   with real depth and lighting. Their first frames are now the card
   illustrations (`site/public/starter-team/`), replacing the ant-mark
   tiles. The characters on the marketing page are the characters a new
   owner meets on day one, and the same two appear inside the product shot
   above as agent avatars.

   The source files are ~1MB animated PNGs; one extracted frame is ~30KB:
   `ffmpeg -i <src> -frames:v 1 <dest>`. Animating them on the page is a
   real option later, at 3MB.

**Wordmark blur, decided.** Not in the original diagnosis: the spray filter
ran `stdDeviation="9"` on a 777-unit face, which reads as texture on Buzz's
low-contrast background watermark and as out of focus on our full-contrast
hero element. Rendered at 9 / 6 / 4 / 2 for the call; **2** shipped, keeping
the spray grain on the edges and the displacement roughening while the
letterforms stay solid. Applied to both copies (site hero and the desktop
app's landing asset).

**Nothing from this document is open.** The next landing-page question is a
different one: whether the page should say anything about the paid
primitives (Discovery, Outreach, Brand) at all before they ship.
