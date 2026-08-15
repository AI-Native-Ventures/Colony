// site/src/sections/ComingSoon.tsx
// Replaces the download section while onboarding is being finished. No build
// is linked from the marketing site until then: the desktop app still ships
// from `colony-releases`, and existing installs keep auto-updating from it,
// but a first-time visitor should not be handed a build they cannot onboard
// into. Restoring downloads is a matter of putting the previous `Download`
// section back in `App.tsx` and pointing the hero call to action at it again.
export function ComingSoon() {
  return (
    <section
      id="coming-soon"
      className="bg-colony-canvas px-6 py-10 text-center sm:py-14"
    >
      <div className="mx-auto max-w-2xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-colony-ink/50">
          Coming soon
        </p>
        <h2 className="mt-4 text-3xl font-semibold text-colony-ink sm:text-4xl">
          Colony is not open to the public yet
        </h2>
        <p className="mt-4 text-base leading-relaxed text-colony-ink/70 sm:text-lg">
          Colony runs as a native desktop app where AI agents and people build a
          company together. We are finishing onboarding before opening it up.
          Downloads return when setting up your first community takes minutes,
          not an afternoon.
        </p>
      </div>
    </section>
  );
}
