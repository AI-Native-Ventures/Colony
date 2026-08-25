// site/src/sections/MeetScout.tsx
// Who you actually talk to. The name and the role are product truth: Colony
// provisions one Chief of Staff at onboarding (see
// desktop/src/features/onboarding/welcomeGuide.ts) and no teammates exist
// until a blueprint is approved. The four lines below are that behaviour in
// plain words, not marketing.
import scoutArt from "@/assets/scout.png";

const DOES = [
  {
    label: "It learns the business",
    body: "From your site, or from questions if there isn't one yet.",
  },
  {
    label: "It does the hiring",
    body: "Proposes the smallest team that can actually do the work.",
  },
  {
    label: "It runs the work",
    body: "Hands jobs out, chases them, tells you when they land.",
  },
  {
    label: "It keeps your day clear",
    body: "You hear from Scout, not from eleven agents at once.",
  },
];

export function MeetScout() {
  return (
    <section className="bg-colony-canvas px-6 py-20 sm:px-10 sm:py-28 lg:px-24">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-20">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-colony-ink/85 sm:text-[13px]">
            Day one
          </p>
          <h2 className="mt-4 max-w-[15ch] text-4xl font-bold leading-[0.96] tracking-[-0.04em] text-colony-ink sm:text-6xl lg:text-[76px]">
            Your first agent is a chief of staff.
          </h2>
          <p className="mt-7 max-w-[48ch] text-lg leading-relaxed text-colony-ink/85 sm:text-xl">
            Scout is a chief of staff: the one who runs a company day to day so
            the owner doesn't have to. It gets to work the moment you arrive,
            and brings in the rest of the team as the work outgrows one pair of
            hands.
          </p>
          <dl className="mt-10 max-w-2xl">
            {DOES.map((item, index) => (
              <div
                key={item.label}
                className={`flex flex-col gap-1 border-t border-colony-ink/30 py-4 text-base leading-snug sm:flex-row sm:gap-6 sm:text-lg ${
                  index === DOES.length - 1 ? "border-b" : ""
                }`}
              >
                <dt className="font-semibold text-colony-ink sm:w-52 sm:shrink-0">
                  {item.label}
                </dt>
                <dd className="text-colony-ink/85">{item.body}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="flex flex-col items-center gap-6">
          {/* The starter-team render the app itself shows at onboarding, so the
              character here is the character a new owner meets on day one. */}
          <div className="flex h-64 w-64 items-end justify-center rounded-full bg-white/55 pb-6 sm:h-[300px] sm:w-[300px] sm:pb-7">
            <img
              src={scoutArt}
              alt="Scout, the Colony chief of staff"
              width={160}
              height={185}
              className="h-40 w-auto sm:h-[185px]"
            />
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold tracking-[-0.03em] text-colony-ink sm:text-3xl">
              Scout
            </p>
            <p className="mt-1.5 text-base font-medium text-colony-ink/85">
              Your chief of staff
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
