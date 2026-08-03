// site/src/sections/Features.tsx

// One row per feature, image shown whole.
//
// This replaced a five-across card grid whose images were forced into a
// fixed 112px-tall `object-cover` box roughly 190px wide. Every screenshot
// was cropped to illegibility — one was sliced mid-sentence — and the source
// files had been captured at that size (195x111), so no CSS change alone
// could have fixed them. The captures now come from
// desktop/tests/e2e/site-feature-screenshots.spec.ts at 2x density, and
// nothing here constrains their aspect ratio: each renders at its natural
// shape, which is why a tall sidebar and a single-line message row can sit
// in the same section without either being cut.
const FEATURES = [
  {
    title: "Channels",
    body: "Threaded, searchable channels scoped to your community: one surface for people and agents alike, plus a shared canvas for the diagrams and drafts that come out of them.",
    image: {
      src: "/feature-channels.png",
      alt: "The Colony sidebar: Inbox, Agents, Blocks, and Discovery above a channel list containing agents, all-replies, deep-history, engineering, general, random, and private channels.",
      width: 580,
      height: 1200,
    },
  },
  {
    title: "Agent teams",
    body: "Spin up specialized agents that read channel history, take on tasks, and hand off work with a visible trail. Define recurring processes as workflow-as-code so they run on events instead of by hand.",
    image: {
      src: "/feature-agents.png",
      alt: "Colony's Agents view showing two custom agents, mira and nadia, both running.",
      width: 1064,
      height: 760,
    },
  },
  {
    title: "Git built in",
    body: "Repos, pull requests, and signed commits live in the same workspace as the conversation about them.",
    image: {
      src: "/feature-git.png",
      alt: "Colony's Projects view with Overview, Repositories, Pull Requests, and Issues tabs above counts of 3 repositories, 69 pull requests, and 74 issues.",
      width: 1980,
      height: 700,
    },
  },
];

export function Features() {
  return (
    <section className="bg-colony-canvasLight px-6 py-14 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <h2 className="text-center text-3xl font-semibold text-colony-ink sm:text-4xl">
          Everything a company needs, in one workspace
        </h2>

        <div className="mt-14 space-y-16 sm:mt-20 sm:space-y-24">
          {FEATURES.map((feature, index) => (
            <div
              key={feature.title}
              className="grid grid-cols-1 items-center gap-8 sm:gap-12 lg:grid-cols-2 lg:gap-16"
            >
              <div
                // Alternate which side the copy sits on. `lg:order-2` on odd
                // rows moves the text after the image on wide screens only;
                // stacked layouts keep title-then-image reading order.
                className={index % 2 === 1 ? "lg:order-2" : undefined}
              >
                <h3 className="text-2xl font-semibold text-colony-ink sm:text-3xl">
                  {feature.title}
                </h3>
                <p className="mt-3 max-w-md text-base leading-relaxed text-colony-ink/70">
                  {feature.body}
                </p>
              </div>

              <div className={index % 2 === 1 ? "lg:order-1" : undefined}>
                {feature.image ? (
                  <img
                    src={feature.image.src}
                    alt={feature.image.alt}
                    width={feature.image.width}
                    height={feature.image.height}
                    // No fixed height and no object-cover: the intrinsic
                    // width/height above reserve the right box before load,
                    // and the image fills the column at its own aspect ratio.
                    // `max-h-[28rem] w-auto` keeps the tall sidebar capture
                    // from towering over the shorter ones.
                    className="mx-auto h-auto w-full max-w-full rounded-2xl border border-colony-ink/10 shadow-xl shadow-colony-ink/10 lg:max-h-[28rem] lg:w-auto"
                  />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
