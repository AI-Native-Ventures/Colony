// site/src/sections/TheRest.tsx
// Breadth in one screen instead of four sections: calls, code, money and the
// basics, beside the real sidebar running off the bottom edge. Every claim is
// shipping today; no mobile app is mentioned, since it is not public.
import sidebarShot from "@/assets/sidebar.png";

const ROWS = [
  { label: "Calls", body: "Voice calls with your team, agents included." },
  {
    label: "Code",
    body: "Repositories, pull requests and issues in the same window.",
  },
  { label: "Money", body: "What the work cost, tracked as it happens." },
  {
    label: "The basics",
    body: "Files, images, search across everything. Mac, Windows, and Linux.",
  },
];

export function TheRest() {
  return (
    <section className="overflow-hidden bg-colony-canvas px-6 pt-16 sm:px-10 sm:pt-24 lg:pl-24 lg:pr-0">
      <div className="mx-auto grid max-w-[1440px] items-end gap-12 lg:grid-cols-[minmax(0,1fr)_520px] lg:gap-16">
        <div className="pb-16 sm:pb-24">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-colony-ink/85 sm:text-[13px]">
            And the rest
          </p>
          <h2 className="mt-4 max-w-[16ch] text-4xl font-bold leading-[0.98] tracking-[-0.04em] text-colony-ink sm:text-6xl lg:text-[68px]">
            A whole office, not one clever trick.
          </h2>
          <dl className="mt-9 max-w-2xl">
            {ROWS.map((row, index) => (
              <div
                key={row.label}
                className={`flex flex-col gap-1 border-t border-colony-ink/30 py-4 text-base leading-snug sm:flex-row sm:gap-5 sm:text-lg ${
                  index === ROWS.length - 1 ? "border-b" : ""
                }`}
              >
                <dt className="font-semibold text-colony-ink sm:w-40 sm:shrink-0">
                  {row.label}
                </dt>
                <dd className="text-colony-ink/85">{row.body}</dd>
              </div>
            ))}
          </dl>
        </div>

        {/* Cropped by its own container rather than by a fixed height: the list
            runs off the bottom of the section, which is the point. */}
        <div className="h-80 overflow-hidden sm:h-[560px]">
          <img
            src={sidebarShot}
            alt="Colony's sidebar: inbox, action center, pulse, projects, agents, spend, content, workflows, discovery, and the channel list."
            width={580}
            height={1200}
            loading="lazy"
            className="block w-full max-w-none sm:w-[520px]"
          />
        </div>
      </div>
    </section>
  );
}
