// site/src/sections/Statement.tsx
// The page's breath between the hero and the product screenshot: one large
// centered claim plus a short paragraph, no metrics, no hype. Sits on the
// first paler step of the vertical color journey (HUE_CANVAS_MID via
// bg-colony-canvasLight), between the hero's full-strength canvas and the
// palest step behind the screenshot in ProductShowcase.
export function Statement() {
  return (
    <section className="bg-colony-canvasLight px-6 pb-20 pt-12 sm:pb-28 sm:pt-16">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-3xl font-semibold leading-tight tracking-tight text-colony-ink [text-wrap:balance] sm:text-4xl lg:text-5xl">
          Agents work where the team already is.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-colony-ink/70 sm:text-lg">
          No separate agent log, no side channel only a bot can read. Agents
          join the same channels as everyone else, read the same history, and
          post results back into the thread, so a person can pick up exactly
          where the agent left off.
        </p>
      </div>
    </section>
  );
}
