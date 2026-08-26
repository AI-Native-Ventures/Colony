// site/src/sections/OrgChart.tsx
// The staffing plan, drawn. This replaces the old ChainOfCommand section,
// which listed the same roles as pills and never showed the shape of the
// company. Solid nodes exist on day one; dashed nodes are what Scout proposes
// and the owner approves into existence, which is exactly how the blueprint
// works in the app (desktop/src/features/company/approveBlueprint.ts).
//
// Two renderings of the same tree: an absolutely positioned chart with drawn
// connectors at lg and up, and a stacked column below that, where a
// three-across chart would be unreadable.
const TEAMS = [
  { name: "Sales", owns: "Finds and writes to customers" },
  { name: "Marketing", owns: "Site, posts, campaigns" },
  { name: "Ops", owns: "Diary, invoices, books" },
];

const FIRST_JOBS = [
  "Fifty businesses worth calling",
  "A first round of emails to approve",
  "A homepage that matches what you sell",
];

function TeamNode({ team }: { team: (typeof TEAMS)[number] }) {
  return (
    <div className="border-2 border-dashed border-white/45 px-6 py-5">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-colony-canvas">
        Waiting for your yes
      </p>
      <p className="mt-2.5 text-xl font-semibold tracking-[-0.02em] sm:text-2xl">
        {team.name}
      </p>
      <p className="mt-2 text-[15px] leading-snug text-white/80">{team.owns}</p>
    </div>
  );
}

export function OrgChart({ scoutArt }: { scoutArt: string }) {
  return (
    <section className="bg-colony-ink px-6 py-20 text-white sm:px-10 sm:py-28 lg:px-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="max-w-[22ch] text-4xl font-bold leading-[0.98] tracking-[-0.04em] sm:text-6xl lg:text-[68px]">
          Your org chart, drafted in week one.
        </h2>
        {/* Drawn chart: connectors run solid from you to Scout, dashed on to the
            teams that do not exist yet. */}
        <div className="relative mt-14 hidden h-[600px] w-full lg:block">
          <svg
            viewBox="0 0 1248 600"
            fill="none"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            role="presentation"
          >
            <title>Connectors from the owner down to the proposed teams</title>
            <path
              d="M624 52 L624 156"
              stroke="var(--colony-canvas)"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <path
              d="M624 262 L624 300 L210 300 L210 400"
              stroke="var(--colony-canvas)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="3 10"
            />
            <path
              d="M624 262 L624 400"
              stroke="var(--colony-canvas)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="3 10"
            />
            <path
              d="M624 262 L624 300 L1038 300 L1038 400"
              stroke="var(--colony-canvas)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="3 10"
            />
          </svg>

          <div className="absolute left-1/2 top-0 flex h-13 w-52 -translate-x-1/2 items-center justify-center bg-white py-3 text-xl font-semibold text-colony-ink">
            You, the owner
          </div>

          <div className="absolute left-1/2 top-[156px] flex h-[106px] w-[360px] -translate-x-1/2 items-center gap-5 bg-colony-canvas px-6 text-colony-ink">
            <img
              src={scoutArt}
              alt=""
              width={80}
              height={92}
              className="h-23 w-auto"
            />
            <div>
              <p className="text-2xl font-bold tracking-[-0.02em]">Scout</p>
              <p className="mt-1 text-[15px] font-medium">
                Chief of staff · already here
              </p>
            </div>
          </div>

          <div className="absolute inset-x-0 top-[400px] grid grid-cols-3 gap-[6%]">
            {TEAMS.map((team) => (
              <TeamNode key={team.name} team={team} />
            ))}
          </div>
        </div>

        {/* Stacked below lg: same nodes, read top to bottom. */}
        <div className="mt-12 flex flex-col gap-4 lg:hidden">
          <div className="bg-white px-6 py-4 text-lg font-semibold text-colony-ink">
            You, the owner
          </div>
          <div className="flex items-center gap-4 bg-colony-canvas px-6 py-4 text-colony-ink">
            <img
              src={scoutArt}
              alt=""
              width={64}
              height={74}
              className="h-16 w-auto"
            />
            <div>
              <p className="text-xl font-bold tracking-[-0.02em]">Scout</p>
              <p className="mt-1 text-sm font-medium">
                Chief of staff · already here
              </p>
            </div>
          </div>
          {TEAMS.map((team) => (
            <TeamNode key={team.name} team={team} />
          ))}
        </div>

        <div className="mt-14 grid items-center gap-12 border-t border-white/25 pt-12 xl:grid-cols-[minmax(0,1fr)_minmax(0,672px)] xl:gap-16">
          <div>
            <p className="text-2xl font-semibold leading-tight tracking-[-0.02em] text-white sm:text-3xl">
              Solid exists. Dashed waits for your yes.
            </p>
            <p className="mt-4 max-w-[32ch] text-lg leading-snug text-white/80">
              Scout can propose a team. Only you can hire one.
            </p>
          </div>

          {/* The plan itself, drawn rather than screenshotted: a capture of the
              in-app blueprint arrives full of table chrome and fixture names. */}
          <div className="bg-white px-7 py-8 text-colony-ink sm:px-9">
            <div className="flex items-baseline justify-between gap-4 border-b border-colony-ink/15 pb-5">
              <p className="text-xl font-bold tracking-[-0.02em] sm:text-[22px]">
                Your company, as proposed
              </p>
              <span className="shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-colony-ink/60">
                Nothing started
              </span>
            </div>

            <p className="mt-6 text-[13px] font-semibold uppercase tracking-[0.16em] text-colony-ink/60">
              The teams
            </p>
            <dl className="mt-3">
              {TEAMS.map((team) => (
                <div
                  key={team.name}
                  className="grid gap-1 border-t border-colony-ink/10 py-3 sm:grid-cols-[130px_minmax(0,1fr)] sm:gap-4"
                >
                  <dt className="text-[17px] font-semibold">{team.name}</dt>
                  <dd className="text-[17px] text-colony-ink/80">
                    {team.owns}
                  </dd>
                </div>
              ))}
            </dl>

            <p className="mt-7 text-[13px] font-semibold uppercase tracking-[0.16em] text-colony-ink/60">
              The first three jobs
            </p>
            <ol className="mt-3">
              {FIRST_JOBS.map((job, index) => (
                <li
                  key={job}
                  className={`flex gap-4 border-t border-colony-ink/10 py-3 text-[17px] ${
                    index === FIRST_JOBS.length - 1 ? "border-b" : ""
                  }`}
                >
                  <span className="font-semibold text-colony-ink/50">
                    {index + 1}
                  </span>
                  <span>{job}</span>
                </li>
              ))}
            </ol>

            <div className="mt-7 flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center bg-colony-ink px-8 py-3.5 text-base font-semibold text-white">
                Approve
              </span>
              <span className="inline-flex items-center border border-colony-ink/35 px-7 py-3.5 text-base font-medium">
                Change something
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
