// site/src/sections/Evidence.tsx
// The proof run: one claim per screen, each with the screen that backs it.
// Screenshots are whole app windows bleeding off the page edge rather than
// sitting in a chrome frame, so nothing is cropped into a sliver and nothing
// floats above the colour field. Regenerate them with:
//   cd desktop && pnpm build:e2e
//   pnpm exec playwright test tests/e2e/site-feature-screenshots.spec.ts
//   pnpm exec playwright test tests/e2e/discovery.spec.ts
import { shotsForActiveHue } from "@/brand/shots";
import type { ReactNode } from "react";

const shots = shotsForActiveHue();

/** One claim beside one screenshot. `flip` puts the image on the left, where
 *  it bleeds off that edge instead. */
function Split({
  label,
  heading,
  body,
  image,
  alt,
  flip = false,
  tone = "white",
}: {
  label: string;
  heading: ReactNode;
  body: string;
  image: string;
  alt: string;
  flip?: boolean;
  tone?: "white" | "ink";
}) {
  const copy = (
    <div className={flip ? "xl:order-2" : undefined}>
      <p
        className={`text-xs font-semibold uppercase tracking-[0.2em] sm:text-[13px] ${
          tone === "ink" ? "text-white/70" : "text-colony-ink/70"
        }`}
      >
        {label}
      </p>
      <h2
        className={`mt-4 text-4xl font-bold leading-[0.98] tracking-[-0.04em] sm:text-5xl lg:text-[68px] ${
          tone === "ink" ? "text-white" : "text-colony-ink"
        }`}
      >
        {heading}
      </h2>
      <p
        className={`mt-6 max-w-[26ch] text-xl leading-snug sm:text-2xl ${
          tone === "ink" ? "text-white/80" : "text-colony-ink/85"
        }`}
      >
        {body}
      </p>
    </div>
  );

  return (
    <section
      className={`overflow-hidden px-6 py-16 sm:px-10 sm:py-24 lg:py-26 ${
        tone === "ink" ? "bg-colony-ink" : "bg-white"
      } ${flip ? "xl:pl-0 xl:pr-24" : "xl:pl-24 xl:pr-0"}`}
    >
      <div
        className={`mx-auto grid max-w-[1440px] items-center gap-10 lg:gap-16 ${
          flip
            ? "xl:grid-cols-[minmax(0,1fr)_460px]"
            : "xl:grid-cols-[460px_minmax(0,1fr)]"
        }`}
      >
        {copy}
        <div
          className={`overflow-hidden ${flip ? "xl:order-1 xl:flex xl:justify-end" : ""}`}
        >
          <img
            src={image}
            alt={alt}
            loading="lazy"
            className={`block w-full max-w-none shrink-0 xl:w-[900px] ${
              tone === "ink" ? "" : "ring-1 ring-colony-ink/10"
            }`}
          />
        </div>
      </div>
    </section>
  );
}

export function SameRoom() {
  return (
    <Split
      label="Working together"
      heading={<>People and agents, same room, same thread.</>}
      body="One conversation. The work and the decisions in the same place."
      image={shots.channel}
      alt="A Colony channel where agents post ranked target companies and people reply to steer them."
    />
  );
}

export function FindCustomers() {
  return (
    <Split
      tone="ink"
      flip
      label="Finding customers"
      heading={<>Tell it who buys from you. It goes and finds them.</>}
      body="34 industries, 500 kinds of business. Pick yours."
      image={shots.industries}
      alt="Colony's customer search: a grid of industries such as professional services, automotive, aerospace and agriculture, each showing how many kinds of business it contains."
    />
  );
}

export function Pipeline() {
  return (
    <Split
      label="By morning"
      heading={<>New customers by morning, with names attached.</>}
      body="Real companies, scored, with the reasoning attached."
      image={shots.pipeline}
      alt="A list of auto repair businesses found by Colony, each with an owner, a status and contact details."
    />
  );
}

export function WorkDelivered() {
  return (
    <Split
      tone="ink"
      label="When it's finished"
      heading={<>Work arrives finished, not promised.</>}
      body="Pages, posts, shortlists. Done, in the thread."
      image={shots.delivered}
      alt="An agent reports a finished website update in a Colony channel and a teammate replies, publish it."
    />
  );
}
