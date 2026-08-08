// site/src/sections/ProductShowcase.tsx
//
// The screenshot is imported rather than referenced from public/ so Vite
// content-hashes it. Under a stable /product-channel.png the first deploy of
// this shot went out successfully and Cloudflare's edge kept serving the old
// engineering-channel capture to anyone without a cache-busting query.
// The single largest piece of evidence on the page: an actual Colony
// screenshot instead of another description. Captured from the real desktop
// app via the E2E screenshot pipeline (just desktop-screenshot), not staged
// or drawn.
//
// The screenshot sits in the shared AppWindow desktop chrome. It replaced a
// near-black padded slab: the dark surround gave the white app an edge to
// push against, but at this size the owner read it as a fake tablet, and
// window chrome tells the truer story (Colony is a desktop app you download).
import productShotUrl from "@/assets/product-channel.png";
import { AppWindow } from "@/sections/AppWindow";

// Regenerating product-channel.png:
//
//   cd desktop && pnpm build:e2e
//   pnpm exec playwright test tests/e2e/site-feature-screenshots.spec.ts \
//     --project=smoke -g "company channel"
//   cp test-results/site-features/product-channel.png ../site/src/assets/
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

        <div className="mt-8">
          <AppWindow>
            <img
              src={productShotUrl}
              alt="A Colony growth channel: Maya Chen sets fit over volume, the agent Scout posts a ranked table of twenty target companies with named decision makers, Daniel Okafor tells it to drop numbers that don't work, the agent Forager reports twenty drafted emails queued for approval with reactions and a reply, and Aisha Bello approves the first ten."
              width={2560}
              height={1640}
              className="w-full"
            />
          </AppWindow>
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
