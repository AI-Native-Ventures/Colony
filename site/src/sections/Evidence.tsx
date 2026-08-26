// site/src/sections/Evidence.tsx
// The proof run: one claim per screen, each with the screen that backs it.
// Screenshots are whole app windows bleeding off the page edge rather than
// sitting in a chrome frame, so nothing is cropped into a sliver and nothing
// floats above the colour field. Regenerate them with:
//   cd desktop && pnpm build:e2e
//   pnpm exec playwright test tests/e2e/site-feature-screenshots.spec.ts
//   pnpm exec playwright test tests/e2e/discovery.spec.ts
import industriesShot from "@/assets/discovery-industries.jpg";
import pipelineShot from "@/assets/discovery-pipeline.png";
import channelShot from "@/assets/product-channel.png";
import deliveredShot from "@/assets/work-delivered.png";
import type { ReactNode } from "react";

/** One claim beside one screenshot. `flip` puts the image on the left, where
 *  it bleeds off that edge instead. */
function Split({
  label,
  heading,
  body,
  image,
  alt,
  flip = false,
  tone = "canvas",
}: {
  label: string;
  heading: ReactNode;
  body: string;
  image: string;
  alt: string;
  flip?: boolean;
  tone?: "canvas" | "white";
}) {
  const copy = (
    <div className={flip ? "lg:order-2" : undefined}>
      <p
        className={`text-xs font-semibold uppercase tracking-[0.2em] sm:text-[13px] ${
          tone === "white" ? "text-colony-ink/70" : "text-colony-ink/85"
        }`}
      >
        {label}
      </p>
      <h2 className="mt-4 text-4xl font-bold leading-[0.98] tracking-[-0.04em] text-colony-ink sm:text-5xl lg:text-[68px]">
        {heading}
      </h2>
      <p className="mt-6 max-w-[26ch] text-xl leading-snug text-colony-ink/85 sm:text-2xl">
        {body}
      </p>
    </div>
  );

  return (
    <section
      className={`overflow-hidden px-6 py-16 sm:px-10 sm:py-24 lg:py-26 ${
        tone === "white" ? "bg-white" : "bg-colony-canvas"
      } ${flip ? "lg:pl-0 lg:pr-24" : "lg:pl-24 lg:pr-0"}`}
    >
      <div
        className={`mx-auto grid max-w-[1440px] items-center gap-10 lg:gap-16 ${
          flip
            ? "lg:grid-cols-[minmax(0,1fr)_460px]"
            : "lg:grid-cols-[460px_minmax(0,1fr)]"
        }`}
      >
        {copy}
        <div
          className={`overflow-hidden ${flip ? "lg:order-1 lg:flex lg:justify-end" : ""}`}
        >
          <img
            src={image}
            alt={alt}
            loading="lazy"
            className="block w-full max-w-none shrink-0 lg:w-[900px]"
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
      image={channelShot}
      alt="A Colony channel where agents post ranked target companies and people reply to steer them."
    />
  );
}

export function FindCustomers() {
  return (
    <Split
      tone="white"
      flip
      label="Finding customers"
      heading={<>Tell it who buys from you. It goes and finds them.</>}
      body="34 industries, 500 kinds of business. Pick yours."
      image={industriesShot}
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
      image={pipelineShot}
      alt="A list of auto repair businesses found by Colony, each with an owner, a status and contact details."
    />
  );
}

export function WorkDelivered() {
  return (
    <Split
      label="When it's finished"
      heading={<>Work arrives finished, not promised.</>}
      body="Pages, posts, shortlists. Done, in the thread."
      image={deliveredShot}
      alt="An agent reports a finished website update in a Colony channel and a teammate replies, publish it."
    />
  );
}
