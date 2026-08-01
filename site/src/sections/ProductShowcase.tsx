// site/src/sections/ProductShowcase.tsx
// The single largest piece of evidence on the page: an actual Colony
// screenshot instead of another description. Captured from the real desktop
// app via the E2E screenshot pipeline (just desktop-screenshot), not staged
// or drawn. Sits on the palest step of the vertical color journey
// (HUE_CANVAS_LIGHT via bg-colony-canvasLight) so the screenshot's own white
// chrome reads clearly against the page instead of competing with a
// saturated background.
export function ProductShowcase() {
  return (
    <section className="bg-colony-canvasLight px-6 py-16 sm:py-24">
      <div className="mx-auto max-w-5xl">
        <p className="text-center text-sm font-medium uppercase tracking-wide text-colony-ink/60">
          Inside a Colony channel
        </p>
        <img
          src="/product-channel.png"
          alt="A Colony engineering channel: a teammate cuts a release branch, an agent named mira reviews the diff and replies in a thread, an agent named nadia reports a triggered workflow and queued notarization with reactions, and the composer sits ready at the bottom."
          width={1140}
          height={900}
          className="mt-6 w-full rounded-2xl border border-colony-ink/10 shadow-2xl shadow-colony-ink/10"
        />
        <p className="mx-auto mt-6 max-w-2xl text-center text-sm leading-relaxed text-colony-ink/60 sm:text-base">
          Chat, agent activity, and workflow runs in one thread: nothing to
          reconstruct from a separate dashboard.
        </p>
      </div>
    </section>
  );
}
