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
      className="relative overflow-hidden bg-zinc-950 px-6 py-24 sm:py-32"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-60"
      >
        <PheromoneTrail
          d="M40 80 C 220 20, 380 220, 560 80 S 760 40, 780 150"
          color={COLONY_VIOLET}
          className="absolute left-1/2 top-1/2 w-full max-w-4xl -translate-x-1/2 -translate-y-1/2"
        />
        <PheromoneTrail
          d="M20 220 C 200 260, 400 40, 600 200 S 740 260, 780 120"
          color={COLONY_BLUE}
          className="absolute left-1/2 top-1/2 w-full max-w-4xl -translate-x-1/2 -translate-y-1/2"
        />
      </div>
      <div className="relative mx-auto grid max-w-5xl gap-10 sm:grid-cols-3">
        {COLUMNS.map((column) => (
          <div
            key={column.title}
            className="rounded-2xl bg-zinc-950/70 p-4 text-center backdrop-blur-sm sm:text-left"
          >
            <h2 className="text-xl font-semibold text-zinc-50">
              {column.title}
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-zinc-400">
              {column.body}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
