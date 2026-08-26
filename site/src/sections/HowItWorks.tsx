// site/src/sections/HowItWorks.tsx
// The map of the product in four lines. Each step is a heading and one
// sentence; the sections below are these four steps with the evidence
// attached, so nothing here needs to explain twice.
const STEPS = [
  {
    number: "01",
    heading: "Send your website",
    body: "It learns what you sell and who buys it.",
  },
  {
    number: "02",
    heading: "Read the plan",
    body: "The roles your business needs, on one page.",
  },
  {
    number: "03",
    heading: "Approve the team",
    body: "They exist the moment you say yes.",
  },
  {
    number: "04",
    heading: "The work starts",
    body: "Anything sent in your name waits for you.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how"
      className="bg-colony-ink px-6 py-24 text-white sm:px-10 sm:py-32 lg:px-24"
    >
      <div className="mx-auto max-w-6xl">
        <h2 className="max-w-[16ch] text-4xl font-bold leading-[0.98] tracking-[-0.04em] sm:text-6xl lg:text-[68px]">
          From your website to a working company.
        </h2>
        <div className="mt-16 grid gap-12 sm:grid-cols-2 sm:gap-x-16 sm:gap-y-14">
          {STEPS.map((step) => (
            <div key={step.number}>
              <p className="text-4xl font-bold tracking-[-0.04em] text-colony-canvas sm:text-[56px]">
                {step.number}
              </p>
              <h3 className="mt-3 text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">
                {step.heading}
              </h3>
              <p className="mt-3 text-lg leading-snug text-white/80 sm:text-xl">
                {step.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
