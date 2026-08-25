// site/src/sections/WhatItIs.tsx
// The first thing a stranger reads after the hero. It answers "what is this"
// in one sentence before any feature, screenshot or product word appears.
// Everything below this section assumes the reader has understood it.
export function WhatItIs() {
  return (
    <section className="bg-colony-canvas px-6 pb-20 pt-20 sm:px-10 sm:pb-28 sm:pt-28 lg:px-24">
      <div className="mx-auto flex max-w-6xl flex-col gap-8 sm:gap-9">
        <h2 className="max-w-[15ch] text-5xl font-bold leading-[0.92] tracking-[-0.05em] text-colony-ink [text-wrap:balance] sm:text-7xl lg:text-[112px]">
          Your company, staffed on day one.
        </h2>
        <p className="max-w-[50ch] text-lg leading-relaxed text-colony-ink/85 sm:text-2xl sm:leading-[1.5]">
          Colony is a workspace where AI agents work alongside your team. They
          find the customers, write the outreach, and deliver the work. You stay
          the one who says yes.
        </p>
      </div>
    </section>
  );
}
