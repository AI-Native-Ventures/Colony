// site/src/sections/Footer.tsx
import { AntMark } from "@/brand/AntMark";

const GITHUB_URL = "https://github.com/AI-Native-Ventures/colony-releases";

export function Footer() {
  return (
    <footer className="border-t border-colony-ink/15 bg-colony-canvas px-6 py-12">
      <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
        <div className="flex items-center gap-3">
          <span className="block w-6 text-colony-ink">
            <AntMark className="h-auto w-full" />
          </span>
          <span className="text-base font-semibold text-colony-ink">
            Colony
          </span>
        </div>
        <div className="flex flex-col items-center gap-1 text-sm text-colony-ink/60 sm:items-end">
          <a
            href={GITHUB_URL}
            className="text-colony-ink/70 underline underline-offset-4 transition hover:text-colony-ink"
          >
            GitHub
          </a>
          <p>Built on Buzz</p>
          <p>AI Native Ventures</p>
        </div>
      </div>
    </footer>
  );
}
