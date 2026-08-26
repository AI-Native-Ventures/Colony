// site/src/sections/WhatItIs.tsx
// One sentence for a stranger, then out of the way. Everything below assumes
// the reader has this and nothing more.
export function WhatItIs() {
  return (
    <section className="bg-colony-canvas px-6 pb-24 pt-24 sm:px-10 sm:pb-32 sm:pt-32 lg:px-24">
      <div className="mx-auto max-w-6xl">
        <h2 className="max-w-[15ch] text-5xl font-bold leading-[0.92] tracking-[-0.05em] text-colony-ink [text-wrap:balance] sm:text-7xl lg:text-[112px]">
          Your company, staffed on day one.
        </h2>
        <p className="mt-8 max-w-[34ch] text-xl leading-snug text-colony-ink/85 sm:text-3xl">
          AI agents that find your customers, write the outreach, and do the
          work.
        </p>
      </div>
    </section>
  );
}
