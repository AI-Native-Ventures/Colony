// site/src/sections/Story.tsx
import { PheromoneTrail } from "@/brand/PheromoneTrail";
import { COLONY_BLUE, COLONY_VIOLET } from "@/brand/palette";

const COLUMNS = [
  {
    title: "Chat",
    body: "Every conversation lives in a channel, threaded and searchable, so agents and people read the same history instead of duplicating context.",
  },
  {
    title: "Agents",
    body: "Agent teams join channels like teammates: they read context, propose changes, and leave a trail anyone can follow and review.",
  },
  {
    title: "Workflows",
    body: "Recurring work runs as workflows triggered by events, so the same steps fire the same way every time, without someone remembering to run them.",
  },
];

export function Story() {
  return (
    <section
      id="story"
      className="relative overflow-hidden bg-zinc-950 px-6 py-12 sm:py-16"
    >
      <h2 className="mx-auto max-w-2xl text-center text-3xl font-semibold text-zinc-50 sm:text-4xl">
        One history, three ways to work
      </h2>
      <div className="relative mx-auto mt-16 grid max-w-5xl gap-10 sm:grid-cols-3">
        <div
          aria-hidden
          className="pointer-events-none absolute left-0 hidden w-full opacity-90 sm:block"
          style={{ top: -50, height: "calc(100% + 50px)" }}
        >
          {/* Touchdown is y=0, the cards' own top edge, not y>0 (inside the
              card): the first version of this arc touched down *inside*
              each card at y=32, so most of its length sat under the cards'
              backdrop-blur and only a ~30px sliver near the peak was ever
              visible. Staying at y<=0 for the whole curve keeps it entirely
              over open background. Touches down at x=157/512/867, the
              measured title-center of columns 1/2/3, so trail A visibly
              links Chat to Agents and trail B links Agents to Workflows. */}
          <PheromoneTrail
            viewBox="0 -50 1024 213"
            d="M157 0 C 260 -44, 410 -44, 512 0"
            color={COLONY_VIOLET}
            className="absolute inset-0 h-full w-full"
          />
          <PheromoneTrail
            viewBox="0 -50 1024 213"
            d="M512 0 C 614 -44, 764 -44, 867 0"
            color={COLONY_BLUE}
            className="absolute inset-0 h-full w-full"
          />
        </div>
        {COLUMNS.map((column) => (
          <div
            key={column.title}
            className="relative rounded-2xl bg-zinc-950/70 p-4 text-center backdrop-blur-sm sm:text-left"
          >
            <h3 className="text-xl font-semibold text-zinc-50">
              {column.title}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              {column.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
