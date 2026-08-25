// site/src/sections/HowItWorks.tsx
// The map of the product, in four plain steps, before a single feature is
// shown. Every later section is one of these steps with the evidence attached,
// so nothing downstream has to re-explain itself.
const STEPS = [
  {
    number: "01",
    heading: "Send your website",
    body: "That is the whole setup. No website yet? It asks you a handful of questions instead: what you sell, who buys it, how you charge.",
  },
  {
    number: "02",
    heading: "Read the staffing plan",
    body: "Back comes a short document: the roles your business needs, what each one owns, and the first three jobs to start on.",
  },
  {
    number: "03",
    heading: "Approve the team",
    body: "Change what you want, then approve. The team is created the moment you do, and not a second before.",
  },
  {
    number: "04",
    heading: "The work starts",
    body: "Customers get found, emails get written, pages get built. Anything addressed to a real human waits for your yes first.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how"
      className="bg-colony-ink px-6 py-20 text-white sm:px-10 sm:py-28 lg:px-24"
    >
      <div className="mx-auto max-w-6xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-colony-canvas sm:text-[13px]">
          How it works
        </p>
        <h2 className="mt-5 max-w-[20ch] text-4xl font-bold leading-[0.98] tracking-[-0.04em] sm:text-6xl lg:text-[68px]">
          From your website to a working company.
        </h2>
        <div className="mt-14 grid gap-12 sm:mt-16 sm:grid-cols-2 sm:gap-x-16 sm:gap-y-14">
          {STEPS.map((step) => (
            <div key={step.number}>
              <p className="text-4xl font-bold tracking-[-0.04em] text-colony-canvas sm:text-[56px]">
                {step.number}
              </p>
              <h3 className="mt-3 text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">
                {step.heading}
              </h3>
              <p className="mt-3.5 text-base leading-relaxed text-white/80 sm:text-lg">
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
