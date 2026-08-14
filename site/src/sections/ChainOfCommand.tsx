// site/src/sections/ChainOfCommand.tsx
// The page's differentiator section: Colony is an org chart, not a chatbot.
// Drawn with typographic chips and connector strokes rather than characters.
// The starter trio stays in the Cards section; repeating three renders
// across eleven org nodes would read as a copy-paste team.
//
// The claim in the closing line is load-bearing and true: the relay refuses
// worker-to-owner contact at ingest, so "can't interrupt you" is
// enforcement, not etiquette. Keep the wording aligned with that fact.

const TEAMS = [
  { lead: "Sales lead", workers: ["Researcher", "Writer"] },
  { lead: "Marketing lead", workers: ["Designer", "Copywriter"] },
  { lead: "Ops lead", workers: ["Scheduler", "Bookkeeper"] },
];

function Connector({
  height = 24,
  className = "",
}: {
  height?: number;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={`w-px bg-colony-ink/30 ${className}`.trim()}
      style={{ height }}
    />
  );
}

export function ChainOfCommand() {
  return (
    <section className="bg-colony-canvasMid px-6 py-20 sm:py-28">
      <div className="mx-auto max-w-4xl text-center">
        <h2 className="mx-auto max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-colony-ink [text-wrap:balance] sm:text-4xl lg:text-5xl">
          A chain of command, not a chatbot.
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-colony-ink/70 sm:text-lg">
          Tell your chief of staff what you need. It briefs the team leaders,
          their teams do the work, and questions climb the ladder only when no
          one below can answer them.
        </p>

        <div className="mt-14 flex flex-col items-center">
          <div className="rounded-full bg-colony-ink px-7 py-2.5 text-sm font-semibold text-colony-canvas">
            You
          </div>
          <Connector />
          <div className="rounded-full border-2 border-colony-ink bg-white px-6 py-2.5 text-sm font-semibold text-colony-ink">
            Chief of staff
          </div>
          <Connector />
          <div className="relative grid w-full max-w-3xl gap-x-6 gap-y-8 sm:grid-cols-3 sm:gap-y-0">
            {/* Rail joining the three team stubs to the chief's connector.
                It spans the outer columns' centres: with three equal columns
                those sit at 1/6 and 5/6 of the row's width. Mobile stacks the
                teams, so the rail and the per-team stubs are sm+ only. */}
            <div
              aria-hidden
              className="absolute top-0 hidden h-px bg-colony-ink/30 sm:block"
              style={{ left: "16.666%", right: "16.666%" }}
            />
            {TEAMS.map((team) => (
              <div key={team.lead} className="flex flex-col items-center">
                <Connector className="hidden sm:block" height={20} />
                <div className="rounded-full border border-colony-ink/60 bg-white px-5 py-2 text-sm font-medium text-colony-ink">
                  {team.lead}
                </div>
                <Connector height={16} />
                <div className="flex gap-2">
                  {team.workers.map((worker) => (
                    <div
                      key={worker}
                      className="rounded-full bg-white/70 px-3.5 py-1.5 text-xs text-colony-ink/70"
                    >
                      {worker}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="mx-auto mt-12 max-w-xl text-sm leading-relaxed text-colony-ink/60 sm:text-base">
          Only what truly needs you reaches you. That's not a promise the agents
          try to keep. It's how the system is built.
        </p>
      </div>
    </section>
  );
}
