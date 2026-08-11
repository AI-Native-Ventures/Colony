// site/src/sections/Jobs.tsx
// Three jobs, three real screenshots. The funnel arc: find customers, reach
// them safely, deliver the work. Every image is a seeded, regenerable
// full-window capture (see desktop/tests/e2e/site-feature-screenshots.spec.ts)
// in the shared AppWindow desktop chrome.
import pipelineShot from "@/assets/discovery-pipeline.png";
import outreachShot from "@/assets/outreach-approval.png";
import deliveredShot from "@/assets/work-delivered.png";
import { AppWindow } from "@/sections/AppWindow";

const JOBS = [
  {
    heading: "Wake up to a full pipeline",
    body: "Your agents search your market, qualify who fits, and score every lead. New customers, found for you, every day.",
    image: pipelineShot,
    alt: "A Colony campaign for auto repair shops: cards of scored leads with owners, statuses, and contact details.",
  },
  {
    heading: "Nothing goes out without your OK",
    body: "Outreach waits in a queue until you approve it. Your name never signs anything you haven't seen.",
    image: outreachShot,
    alt: "Colony's outreach queue: drafts awaiting approval, each with an Approve button, and a metric card counting drafts ready.",
  },
  {
    heading: "The work shows up done",
    body: "Website updates, social posts, candidate shortlists, client deliverables: finished work arrives in the conversation, ready for you to review.",
    image: deliveredShot,
    alt: "An agent reports a finished website update in a Colony channel; a teammate replies 'Publish it' and reactions land on the message.",
  },
];

export function Jobs() {
  return (
    <section className="bg-colony-canvasLight px-6 py-20 sm:py-28">
      <div className="mx-auto flex max-w-6xl flex-col gap-20 sm:gap-28">
        {JOBS.map((job, index) => (
          <div
            key={job.heading}
            className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14"
          >
            <div className={index % 2 === 1 ? "lg:order-2" : undefined}>
              <h3 className="text-2xl font-semibold leading-tight tracking-tight text-colony-ink sm:text-3xl">
                {job.heading}
              </h3>
              <p className="mt-4 max-w-md text-base leading-relaxed text-colony-ink/70 sm:text-lg">
                {job.body}
              </p>
            </div>
            <AppWindow>
              <img
                src={job.image}
                alt={job.alt}
                className="w-full"
                loading="lazy"
              />
            </AppWindow>
          </div>
        ))}
      </div>
    </section>
  );
}
