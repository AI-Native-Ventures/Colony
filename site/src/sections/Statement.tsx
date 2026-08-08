// site/src/sections/Statement.tsx
// The page's breath between the hero and the product screenshot: one large
// centered claim plus a short paragraph, no metrics, no hype. Sits on the
// first paler step of the vertical color journey (HUE_CANVAS_MID via
// bg-colony-canvasMid), between the hero's full-strength canvas and the
// palest step behind the screenshot in ProductShowcase. The class here read
// canvasLight while the comment claimed canvasMid, which collapsed the first
// two steps of the journey into one flat pale run from the hero to the
// screenshot.
export function Statement() {
  return (
    <section className="bg-colony-canvasMid px-6 pb-20 pt-12 sm:pb-28 sm:pt-16">
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-3xl font-semibold leading-tight tracking-tight text-colony-ink [text-wrap:balance] sm:text-4xl lg:text-5xl">
          Delegate real work, not prompts.
        </h2>
        <p className="mx-auto mt-6 max-w-xl text-base leading-relaxed text-colony-ink/70 sm:text-lg">
          Colony gives you a team of AI agents that find customers, write the
          outreach, and do the work. You stay in charge of what matters.
        </p>
      </div>
    </section>
  );
}
