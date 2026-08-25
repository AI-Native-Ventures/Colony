// site/src/sections/ComingSoon.tsx
// The close. No build is linked while onboarding is being finished: the app
// still ships from `colony-releases` and existing installs keep updating, but
// a first-time visitor should not be handed a build they cannot onboard into.
// Restoring downloads means putting the Download section back and pointing the
// hero call to action at it again.
export function ComingSoon() {
  return (
    <section
      id="coming-soon"
      className="bg-colony-canvas px-6 pb-20 pt-16 sm:px-10 sm:pb-28 sm:pt-24 lg:px-24"
    >
      <div className="mx-auto max-w-6xl">
        <h2 className="max-w-[15ch] text-5xl font-bold leading-[0.95] tracking-[-0.045em] text-colony-ink sm:text-7xl lg:text-[88px]">
          Not open to the public yet.
        </h2>
        <p className="mt-7 max-w-[50ch] text-base leading-relaxed text-colony-ink/85 sm:text-lg">
          Colony is a desktop app for Mac, Windows and Linux. We are finishing
          the setup experience before we open it up. Downloads come back when
          starting your first company takes minutes, not an afternoon.
        </p>
      </div>
    </section>
  );
}
