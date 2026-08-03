# Landing page: the real gap vs buzz.xyz

**Status:** Diagnosed 2026-08-03 from side-by-side captures. Not implemented.

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

1. **Reframe ProductShowcase**: near-black rounded frame, generous padding,
   wider. Cheap, large payoff, pure CSS.
2. **Richer seeded screenshot content**: human names, avatar images, a code
   block, reactions, a threaded reply with substance. The E2E mock supports
   all of this (`--messages` passes `extraTags`, `parentEventId`, `pubkey`);
   it needs a fixture written with care, not more capture tuning.
3. **Three cards instead of alternating rows**, matching the card shape
   above.
4. **Character illustrations.** The real gap and the real cost. Three ant
   characters with depth and lighting, or a deliberate flat-illustration
   style owned as a choice. Not something to fake with the existing SVG mark
   scaled up — that is what the current dot-grid Canvas tile looked like, and
   it read as a placeholder.

Item 4 is a design commission, not a code change. Items 1-3 are a focused
session against these captures.
