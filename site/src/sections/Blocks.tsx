// site/src/sections/Blocks.tsx
// Blocks are the thing the old page never mentioned: the working panels an
// agent places in a conversation (desktop/src/features/blocks). The core set
// is lead-card, approval, agent-proposal, report, artifact, receipt,
// brainstorm, company-brief, company-blueprint and interview; the six tiles
// below name them the way an owner would, not the way the catalog does.
//
// The word "blocks" only appears here, after the reader has already been shown
// two of them (the staffing plan and the approval).
const KINDS = [
  "A customer found",
  "Something to approve",
  "A finished report",
  "A receipt to file",
  "A few questions",
  "A plan to sign off",
];

export function Blocks() {
  return (
    <section className="bg-colony-ink px-6 py-20 text-white sm:px-10 sm:py-28 lg:px-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="max-w-[20ch] text-4xl font-bold leading-[0.98] tracking-[-0.04em] sm:text-6xl lg:text-[68px]">
          It asks with a button, not a paragraph.
        </h2>
        <p className="mt-5 max-w-[54ch] text-base leading-relaxed text-white/80 sm:text-lg">
          The approval you just saw, and the staffing plan before it, are
          working panels an agent drops into the thread. Colony calls them
          blocks. Answer where they sit and the reply goes straight back to
          whoever asked.
        </p>

        <div className="mt-14 grid items-center gap-12 xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)] xl:gap-16">
          {/* A lead card as an owner sees it: the company, the person, and how
              well it fits, with the evidence one click away. */}
          <div className="bg-white px-7 py-7 text-colony-ink sm:px-8">
            <div className="flex items-baseline justify-between gap-4">
              <p className="text-lg font-bold tracking-[-0.02em] sm:text-xl">
                Northside Auto Repair
              </p>
              <span className="shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-colony-ink/60">
                Qualified
              </span>
            </div>
            <dl className="mt-5">
              <div className="grid gap-1 border-t border-colony-ink/10 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
                <dt className="text-base text-colony-ink/60">Owner</dt>
                <dd className="text-base font-medium">Dana Whitfield</dd>
              </div>
              <div className="grid gap-2 border-t border-colony-ink/10 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center sm:gap-4">
                <dt className="text-base text-colony-ink/60">Fit score</dt>
                <dd className="flex items-center gap-3.5">
                  <span className="text-xl font-bold tracking-[-0.02em]">
                    87
                  </span>
                  <span className="block h-2 w-40 bg-colony-ink/12 sm:w-52">
                    <span className="block h-2 w-[87%] bg-colony-ink" />
                  </span>
                </dd>
              </div>
            </dl>
            <div className="mt-6 flex flex-wrap items-center gap-4">
              <span className="inline-flex items-center bg-colony-ink px-7 py-3.5 text-base font-semibold text-white">
                Review the evidence
              </span>
              <span className="inline-flex items-center border border-colony-ink/35 px-6 py-3.5 text-base font-medium">
                Not for us
              </span>
            </div>
          </div>

          <div>
            {/* The 2px gaps are the ink background showing through, so the
                tiles share edges instead of floating as cards. */}
            <div className="grid gap-0.5 bg-white/25 sm:grid-cols-2">
              {KINDS.map((kind) => (
                <div key={kind} className="bg-colony-ink px-5 py-5">
                  <p className="text-lg font-semibold">{kind}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
