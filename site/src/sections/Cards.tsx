// site/src/sections/Cards.tsx
// The page's one below-the-fold content section: a large centered claim over
// three equal white cards.
//
// This replaced two separate sections that were each solving the same job
// badly — Story (three flat tinted columns) and Features (three full-width
// alternating screenshot rows). The alternating rows put a 1980px-wide
// screenshot and a 580px-tall sidebar in the same vertical stack, so the page
// lurched between shapes and ran on for three viewport-heights without
// saying anything the product shot above had not already said.
//
// One statement, three cards, done. The screenshots those rows used are gone
// from site/public rather than left behind unreferenced, since every file
// there ships in the deploy. They are reproducible whenever a features page
// wants them: run desktop/tests/e2e/site-feature-screenshots.spec.ts and copy
// test-results/site-features/feature-*.png back in.
import { AntMark } from "@/brand/AntMark";
import { PheromoneTrail } from "@/brand/PheromoneTrail";
import { getActiveHue, HUE_ACCENT, HUE_SCATTER_TONES } from "@/brand/hue";

// The illustration slot. Each card gets a tinted tile carrying the ant mark
// rather than a scaled-up bare SVG: a lone flat mark floating on white read
// as a missing asset, where a tile reads as a deliberate icon. Tones step
// down the same violet family (dark, accent, pale) so three cards vary in
// weight without the page growing three competing hues, and the pale tile
// flips its mark to ink to hold contrast.
const TILES = [
  { tile: 0, mark: "#ffffff" },
  { tile: 1, mark: "#ffffff" },
  { tile: 2, mark: "#171717" },
] as const;

const CARDS = [
  {
    title: "Communicate with your team",
    body: "Keep people, context, decisions, and next steps in one shared room. No more chasing threads, docs, and status updates.",
  },
  {
    title: "Bring in your agents",
    body: "Invite specialized agents into the conversation so they compare notes, divide work, and build on your team's context.",
  },
  {
    title: "Manage your git projects",
    body: "Turn the discussion into plans, code, reviews, and PRs without hopping between your tracker, chat app, and dev tools.",
  },
];

export function Cards() {
  const hue = getActiveHue();
  // Scatter tones are ordered [dark, accent, pale, white]; the first three
  // are the tile fills, indexed by TILES[n].tile.
  const tones = HUE_SCATTER_TONES[hue];
  const trailA = HUE_ACCENT[hue];
  const trailB = tones[0];

  return (
    <section
      id="story"
      className="relative overflow-hidden bg-colony-canvasMid px-6 py-20 sm:py-28"
    >
      <h2 className="mx-auto max-w-3xl text-center text-3xl font-semibold leading-tight tracking-tight text-colony-ink [text-wrap:balance] sm:text-4xl lg:text-5xl">
        Your people, your agents, your project, all in one place.
      </h2>

      <div className="relative mx-auto mt-16 grid max-w-5xl gap-5 sm:mt-20 sm:grid-cols-3">
        {/* Trails arc between card centres in the open background above the
            row, touching down at y=0 (the cards' own top edge). Dipping below
            that buries the curve under the cards' opaque white fill.

            The band is sized to the viewBox's exact aspect (1024x56), not to
            the card row: an SVG keeps its aspect ratio by default, so the
            earlier version — a 1216x213 viewBox stretched over a 1152x434
            band — scaled to fit the height and pushed all but a stub of each
            curve outside the visible width. Touchdowns at x=164/512/860 are
            the card centres of a max-w-5xl (1024px) three-column grid with a
            20px gap. */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 hidden w-full opacity-90 sm:block"
          style={{ top: -56, height: 56 }}
        >
          <PheromoneTrail
            viewBox="0 -56 1024 56"
            d="M164 0 C 250 -50, 426 -50, 512 0"
            color={trailA}
            className="absolute inset-0 h-full w-full"
          />
          <PheromoneTrail
            viewBox="0 -56 1024 56"
            d="M512 0 C 598 -50, 774 -50, 860 0"
            color={trailB}
            className="absolute inset-0 h-full w-full"
          />
        </div>

        {CARDS.map((card, index) => (
          <div
            key={card.title}
            // The copy sits at a fixed offset below the tile, not pushed down
            // by `mt-auto`. Bottom-anchoring aligned the cards' bottom edges
            // but floated the headings to different heights whenever one body
            // wrapped to an extra line, and the heading row is the line the
            // eye actually tracks across the three cards. A fixed offset
            // aligns the headings; the grid still stretches every card to the
            // tallest one, so the bottom edges stay level too.
            className="relative flex min-h-[24rem] flex-col rounded-2xl bg-white p-6 shadow-sm shadow-colony-ink/5"
          >
            <div
              className="flex h-24 w-24 items-center justify-center rounded-2xl"
              style={{
                backgroundColor: tones[TILES[index].tile],
                color: TILES[index].mark,
              }}
            >
              <AntMark className="w-16" />
            </div>

            <div className="mt-32">
              <h3 className="text-sm font-semibold text-colony-ink">
                {card.title}
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-colony-ink/70">
                {card.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
