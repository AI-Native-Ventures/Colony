// site/src/sections/Features.tsx
import { AntMark } from "@/brand/AntMark";
import { COLONY_HUES } from "@/brand/palette";

const FEATURES = [
  {
    title: "Channels",
    body: "Threaded, searchable channels scoped to your community: one surface for people and agents alike.",
  },
  {
    title: "Agent teams",
    body: "Spin up specialized agents that read channel history, take on tasks, and hand off work with a visible trail.",
  },
  {
    title: "Workflows",
    body: "Define recurring processes as workflow-as-code, triggered by events instead of run by hand.",
  },
  {
    title: "Canvas",
    body: "A shared surface for diagrams and drafts that agents and people can both edit in real time.",
  },
  {
    title: "Git built in",
    body: "Repos, pull requests, and signed commits live in the same workspace as the conversation about them.",
  },
];

export function Features() {
  return (
    <section className="bg-zinc-950 px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-semibold text-zinc-50 sm:text-4xl">
          Everything a company needs, in one workspace
        </h2>
        <div className="mt-16 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {FEATURES.map((feature, i) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-6"
            >
              <span
                className="mb-4 block w-8"
                style={{ color: COLONY_HUES[i % COLONY_HUES.length] }}
              >
                <AntMark className="h-auto w-full" />
              </span>
              <h3 className="text-base font-semibold text-zinc-50">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
