// site/src/sections/Approval.tsx
// The promise the product is built around, shown as the panel an agent
// actually posts. Drawn rather than screenshotted: a capture of the real
// approval block ships fixture addresses and a raw epoch expiry, which reads
// as debug output on a landing page. The fields mirror the block's contract
// (destination, exact content, decision).
export function Approval() {
  return (
    <section className="bg-white px-6 py-16 sm:px-10 sm:py-24 lg:px-24">
      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[440px_minmax(0,1fr)] lg:gap-16">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-colony-ink/70 sm:text-[13px]">
            Before anything sends
          </p>
          <h2 className="mt-4 text-4xl font-bold leading-[0.98] tracking-[-0.04em] text-colony-ink sm:text-5xl lg:text-[60px]">
            Nothing goes out in your name unread.
          </h2>
          <p className="mt-6 max-w-[38ch] text-base leading-relaxed text-colony-ink/80 sm:text-lg">
            Before an agent contacts a real person it stops, shows you the
            address and the exact words, and waits. Two buttons. That is the
            whole review.
          </p>
        </div>

        <div className="border border-colony-ink/15 px-7 py-7 sm:px-8">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-lg font-bold tracking-[-0.02em] text-colony-ink sm:text-xl">
              Approval needed before this sends
            </p>
            <span className="shrink-0 text-xs font-semibold uppercase tracking-[0.14em] text-colony-ink/60">
              Waiting
            </span>
          </div>
          <dl className="mt-5">
            <div className="grid gap-1 border-t border-colony-ink/10 py-3 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-base text-colony-ink/60">To</dt>
              <dd className="text-base font-medium text-colony-ink">
                Dana Whitfield, Northside Auto Repair
              </dd>
            </div>
            <div className="grid gap-1 border-t border-colony-ink/10 py-3 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-base text-colony-ink/60">Subject</dt>
              <dd className="text-base font-medium text-colony-ink">
                Your booking page is costing you jobs
              </dd>
            </div>
            <div className="grid gap-1 border-y border-colony-ink/10 py-3 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-4">
              <dt className="text-base text-colony-ink/60">Message</dt>
              <dd className="text-base leading-relaxed text-colony-ink/85">
                Hi Dana, I had a look at your site. Customers can't book a slot
                without calling you first, and half of them won't. We rebuilt
                that page for a shop your size last month, happy to show you.
              </dd>
            </div>
          </dl>
          <div className="mt-6 flex flex-wrap items-center gap-4">
            <span className="inline-flex items-center bg-colony-ink px-8 py-3.5 text-base font-semibold text-white">
              Send it
            </span>
            <span className="inline-flex items-center border border-colony-ink/35 px-6 py-3.5 text-base font-medium text-colony-ink">
              Not this one
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
