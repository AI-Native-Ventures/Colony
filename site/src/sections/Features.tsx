// site/src/sections/Features.tsx
import { AntMark } from "@/brand/AntMark";

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
    <section className="bg-colony-canvas px-6 py-14 sm:py-20">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-semibold text-colony-ink sm:text-4xl">
          Everything a company needs, in one workspace
        </h2>
        <div className="mt-16 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-5">
          {FEATURES.map((feature) => (
            <div
              key={feature.title}
              className="rounded-2xl border border-colony-ink/10 bg-colony-ink/5 p-6"
            >
              {/* Ant on an ink badge, same pairing as the packaged app icon
                  (white ant on violet), inverted per hue: canvas-tint ant
                  on ink. Keeps AntMark itself wingless and untouched. */}
              <span className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-xl bg-colony-ink text-colony-canvas">
                <AntMark className="h-5 w-5" />
              </span>
              <h3 className="text-base font-semibold text-colony-ink">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-colony-ink/70">
                {feature.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
