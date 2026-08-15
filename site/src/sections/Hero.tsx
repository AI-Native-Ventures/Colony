// site/src/sections/Hero.tsx
import wordmarkUrl from "@/assets/colony-wordmark.svg";
import { ScatterField } from "@/brand/ScatterField";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-colony-canvas px-6 pb-16 pt-14 sm:px-10 sm:pb-24 sm:pt-16 lg:flex lg:min-h-screen lg:flex-col lg:justify-center lg:px-16 lg:pt-20">
      <ScatterField />
      <div className="relative z-10 mx-auto flex max-w-7xl flex-col gap-10 lg:grid lg:max-w-[1600px] lg:grid-cols-[1.8fr_1fr] lg:items-center lg:gap-16">
        <div className="flex flex-col items-start">
          <img
            // The SVG, not the PNG raster of it. Both carry the same spray
            // filter, but the hero renders the mark ~640px wide and the PNG
            // is only 777px, so on a retina display it was being upscaled
            // past its own resolution: the spray texture and the letterforms
            // smeared together into one soft blob. The SVG stays sharp at any
            // density. Its Inter face is embedded as a data-URI @font-face,
            // which resolves inside an <img> where an external font URL would
            // not.
            // Imported, not referenced from public/: Vite gives the emitted
            // file a content hash, so a changed wordmark ships under a new URL
            // instead of colliding with the edge's cached copy of the old one.
            // A stable /colony-wordmark.svg kept serving the pre-2026-08-04
            // blur radius from Cloudflare's cache after a successful deploy.
            src={wordmarkUrl}
            alt="Colony"
            width={777}
            height={326}
            className="w-full max-w-[22rem] sm:max-w-[30rem] lg:max-w-none"
          />
        </div>
        <div className="flex flex-col items-start text-left">
          <h1 className="text-4xl font-semibold tracking-tight text-colony-ink sm:text-5xl lg:text-6xl xl:text-7xl">
            Run your company with AI agents
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-colony-ink/70 sm:mt-8 sm:text-lg lg:text-xl">
            Colony is a workspace where AI agents and people build a company
            together: chat, agent teams, workflows, canvas, and git.
          </p>
          <div className="mt-10 flex flex-col items-start gap-4 sm:mt-12 sm:flex-row sm:items-center lg:mt-14">
            <a
              href="#coming-soon"
              className="rounded-full bg-colony-ink px-8 py-3 text-base font-medium text-colony-canvas transition hover:opacity-90 lg:px-10 lg:py-4 lg:text-lg"
            >
              Coming soon
            </a>
            <a
              href="#story"
              className="text-base font-medium text-colony-ink underline underline-offset-4 transition hover:opacity-70 lg:text-lg"
            >
              How it works
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
