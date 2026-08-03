// site/src/sections/ProductShowcase.tsx
// The single largest piece of evidence on the page: an actual Colony
// screenshot instead of another description. Captured from the real desktop
// app via the E2E screenshot pipeline (just desktop-screenshot), not staged
// or drawn.
//
// The screenshot sits inside a near-black frame with deep padding, and that
// frame is the whole point of this section. Before it, the shot was a
// thin-bordered image on the page's palest tint: the app's own white chrome
// against a near-white background, so the most important thing on the page
// receded into it. Dark surround gives the white chrome an edge to push
// against, and the padding reads as a device rather than a pasted image.
//
// #211f1f, not colony-ink (#171717): a frame at pure ink matched the body
// text's own colour and flattened against the footer's dark band. Lifting it
// a few points keeps it reading as a surface.
const FRAME = "#211f1f";

// Regenerating product-channel.png:
//
//   cd desktop && pnpm build:e2e
//   pnpm exec playwright test tests/e2e/site-feature-screenshots.spec.ts \
//     --project=smoke -g "company channel"
//   cp test-results/site-features/product-channel.png ../site/public/
//
// The spec ("capture: the company channel hero shot") owns the whole frame:
// the people, the agents, the seeded thread, and the sidebar. It captures the
// window at 1280x820 and 2x density, so the committed file is 2560x1640 and
// needs no cropping — an earlier hand-cropped capture had carried a strip of
// Buzz-era chartreuse down two of its edges.

export function ProductShowcase() {
  return (
    <section className="bg-colony-canvasLight px-6 py-16 sm:py-24">
      <div className="mx-auto max-w-6xl">
        <p className="text-center text-sm font-medium uppercase tracking-wide text-colony-ink/60">
          Inside a Colony channel
        </p>

        <div
          // Padding scales with the viewport: at phone widths a 4rem inset
          // would leave the screenshot narrower than the text above it.
          className="mt-8 rounded-3xl p-4 shadow-2xl shadow-colony-ink/20 sm:p-10 lg:p-16"
          style={{ backgroundColor: FRAME }}
        >
          <img
            src="/product-channel.png"
            alt="A Colony growth channel: Maya Chen sets fit over volume, the agent Scout posts a ranked table of twenty target companies with named decision makers, Daniel Okafor tells it to drop numbers that don't work, the agent Forager reports twenty drafted emails queued for approval with reactions and a reply, and Aisha Bello approves the first ten."
            width={2560}
            height={1640}
            className="w-full rounded-xl"
          />
        </div>

        <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-colony-ink/60 sm:text-base">
          Your team and your agents work in the same thread. The agents bring
          back what they found, people redirect them in a line, and nothing goes
          out until someone approves it.
        </p>
      </div>
    </section>
  );
}
