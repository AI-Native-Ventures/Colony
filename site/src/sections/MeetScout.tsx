// site/src/sections/MeetScout.tsx
// Who you talk to, in one line. Colony provisions a single Chief of Staff at
// onboarding and no teammates exist until a blueprint is approved
// (desktop/src/features/onboarding/welcomeGuide.ts); the four words below are
// that behaviour, not a feature list.
import scoutArt from "@/assets/scout.png";

const DOES = [
  "Learns the business",
  "Does the hiring",
  "Runs the work",
  "Keeps your day clear",
];

export function MeetScout() {
  return (
    <section className="bg-colony-canvas px-6 py-24 sm:px-10 sm:py-32 lg:px-24">
      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-16 xl:grid-cols-[minmax(0,1fr)_360px] xl:gap-20">
        <div>
          <h2 className="max-w-[15ch] text-4xl font-bold leading-[0.96] tracking-[-0.04em] text-colony-ink sm:text-6xl lg:text-[76px]">
            Your first agent is a chief of staff.
          </h2>
          <p className="mt-7 max-w-[34ch] text-xl leading-snug text-colony-ink/85 sm:text-2xl">
            Scout learns the business, hires the rest, and keeps the noise off
            your desk.
          </p>
          <ul className="mt-9 flex flex-wrap gap-x-8 gap-y-3 text-base font-medium text-colony-ink/85 sm:text-lg">
            {DOES.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="flex flex-col items-center gap-6">
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
