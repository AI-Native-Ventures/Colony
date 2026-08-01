// site/src/sections/Hero.tsx
import { AntMark } from "@/brand/AntMark";
import { ScatterField } from "@/brand/ScatterField";

export function Hero() {
  return (
    <section className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-zinc-950 px-6 text-center">
      <ScatterField />
      <div className="relative z-10 flex flex-col items-center">
        <span className="mb-8 block w-16 text-colony-violet sm:w-20">
          <AntMark className="h-auto w-full" />
        </span>
        <h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-zinc-50 sm:text-6xl">
          Run your company with AI agents
        </h1>
        <p className="mt-6 max-w-xl text-base leading-relaxed text-zinc-400 sm:text-lg">
          Colony is a workspace where AI agents and people build a company
          together: chat, agent teams, workflows, canvas, and git.
        </p>
        <div className="mt-10 flex flex-col items-center gap-4 sm:flex-row">
          <a
            href="#download"
            className="rounded-full bg-colony-violet px-8 py-3 text-base font-medium text-zinc-950 transition hover:opacity-90"
          >
            Download for macOS
          </a>
          <a
            href="#story"
            className="text-base font-medium text-zinc-300 underline underline-offset-4 transition hover:text-zinc-50"
          >
            How it works
          </a>
        </div>
      </div>
    </section>
  );
}
