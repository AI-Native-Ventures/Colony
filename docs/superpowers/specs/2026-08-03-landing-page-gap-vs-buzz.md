# Landing page: the real gap vs buzz.xyz

**Status:** Diagnosed 2026-08-03 from side-by-side captures. Items 1 and 3
implemented the same day (commit `6424dc44f`). Items 2 and 4 remain open.

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
2. **Richer seeded screenshot content**: human names, avatar images, a code
   block, reactions, a threaded reply with substance. The E2E mock supports
   all of this (`--messages` passes `extraTags`, `parentEventId`, `pubkey`);
   it needs a fixture written with care, not more capture tuning.
3. ~~**Three cards instead of alternating rows**~~ — done, as
   `site/src/sections/Cards.tsx`, replacing both Story and Features. 1024px
   row, 20px gutters, ~24rem cards, headings on a fixed offset below the
   tile so they align across all three regardless of body length.
4. **Character illustrations.** The real gap and the real cost. Three ant
   characters with depth and lighting, or a deliberate flat-illustration
   style owned as a choice. Not something to fake with the existing SVG mark
   scaled up — that is what the current dot-grid Canvas tile looked like, and
   it read as a placeholder.

Item 4 is a design commission, not a code change. The card illustration slot
now ships with the ant mark on a tinted tile, stepping down the violet family
per card. That is deliberately a holding pattern, not the answer: it reads as
an icon system rather than a missing asset, which a bare scaled-up mark on
white did not, but it has none of the weight three rendered characters carry.

One more open item, not in the original diagnosis: the wordmark's spray
filter runs `stdDeviation="9"` on a 250px face
(`desktop/public/landing/colony-wordmark.svg`). Buzz uses its sprayed
wordmark as a low-contrast background watermark, where that reads as
texture. Ours is a full-contrast foreground element in the hero, where it
reads as out of focus. Switching the site from the PNG raster to the SVG
recovered the grain, but the blur radius itself is a brand decision and was
left alone.
